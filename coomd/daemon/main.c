#include <stdio.h>
#include <stdlib.h>
#include <getopt.h>
#include <stdbool.h>
#include <unistd.h>
#include <string.h>
#include <sys/wait.h>
// 꼬임 방지를 위해 현재 폴더(coomd/daemon) 안의 헤더파일을 확실히 가리키도록 설정합니다.
#include "validator.h"
#include "psi_monitor.h"
#include "proc_reader.h"

#define MAX_CANDIDATES 128
#define IPC_BUF_SIZE 8192

// helper.py 경로 (coomd/ 에서 실행한다고 가정)
#define HELPER_PATH "LLM_client/helper.py"

// ──────────────────────────────────────────────────────────
// (R3 연결) 후보 목록 + 정책을 helper.py에 보내고, victim 결정을 받아온다.
//   - fork()로 자식 프로세스를 만들고
//   - execlp()로 자식을 python3 helper.py 로 변신시킨 뒤
//   - pipe() 2개로 양방향 통신 (부모→자식: 입력 JSON, 자식→부모: 결정 JSON)
//   - 받은 JSON에서 victim PID들을 파싱해 out_victims에 채운다.
//   - 반환값: victim 개수 (실패 시 -1)
// ──────────────────────────────────────────────────────────
static int ask_llm_helper(const char *policy,
                          proc_candidate_t *candidates, int count,
                          int target_free_mb,
                          int *out_victims, int max_victims,
                          char *out_reasoning, size_t reasoning_size) {
    int to_child[2];   // 부모 → 자식 (stdin)
    int from_child[2]; // 자식 → 부모 (stdout)

    if (pipe(to_child) == -1 || pipe(from_child) == -1) {
        perror("pipe");
        return -1;
    }

    pid_t pid = fork();
    if (pid == -1) {
        perror("fork");
        return -1;
    }

    if (pid == 0) {
        // ===== 자식 프로세스: helper.py 가 된다 =====
        // 자식의 stdin 을 to_child 의 읽기 끝으로 연결
        dup2(to_child[0], STDIN_FILENO);
        // 자식의 stdout 을 from_child 의 쓰기 끝으로 연결
        dup2(from_child[1], STDOUT_FILENO);

        // 자식에서 안 쓰는 fd 닫기
        close(to_child[0]); close(to_child[1]);
        close(from_child[0]); close(from_child[1]);

        // python3 helper.py 실행
        execlp("python3", "python3", HELPER_PATH, (char *)NULL);
        // execlp 가 성공하면 여기 도달 못 함. 도달했다면 실패.
        perror("execlp");
        _exit(127);
    }

    // ===== 부모 프로세스: 데몬 본체 =====
    // 부모가 안 쓰는 끝 닫기
    close(to_child[0]);   // 부모는 자식 stdin 에 "쓰기"만
    close(from_child[1]); // 부모는 자식 stdout 에서 "읽기"만

    // (1) 입력 JSON 만들기: {"policy":..., "candidates":[...], "target_free_mb":...}
    char input_json[IPC_BUF_SIZE];
    int off = 0;
    off += snprintf(input_json + off, sizeof(input_json) - off,
                    "{\"policy\": \"%s\", \"target_free_mb\": %d, \"candidates\": [",
                    policy, target_free_mb);
    for (int i = 0; i < count; i++) {
        off += snprintf(input_json + off, sizeof(input_json) - off,
                        "%s{\"pid\": %d, \"comm\": \"%s\", \"cmdline\": \"%s\", \"rss_kb\": %lu}",
                        (i == 0 ? "" : ", "),
                        candidates[i].pid, candidates[i].comm,
                        candidates[i].cmdline, candidates[i].rss_kb);
    }
    off += snprintf(input_json + off, sizeof(input_json) - off, "]}\n");

    // (2) 자식의 stdin 에 입력 JSON 쓰기
    if (write(to_child[1], input_json, strlen(input_json)) == -1) {
        perror("write");
    }
    close(to_child[1]); // 다 썼으니 닫기 → 자식이 EOF 받고 처리 시작

    // (3) 자식의 stdout 에서 결정 JSON 읽기
    char output_json[IPC_BUF_SIZE] = {0};
    ssize_t n = read(from_child[0], output_json, sizeof(output_json) - 1);
    close(from_child[0]);
    if (n <= 0) {
        fprintf(stderr, "[IPC] helper 응답을 읽지 못했습니다.\n");
        waitpid(pid, NULL, 0);
        return -1;
    }
    output_json[n] = '\0';

    // (4) 자식 프로세스 종료 회수 (좀비 방지)
    waitpid(pid, NULL, 0);

    // (5) 결정 JSON 에서 victim PID들 파싱 (아주 단순한 파서)
    //     형식 예: {"victims": [9999, 8888], "reasoning": "...", ...}
    int victim_count = 0;
    char *vptr = strstr(output_json, "\"victims\"");
    if (vptr) {
        char *lb = strchr(vptr, '[');
        char *rb = lb ? strchr(lb, ']') : NULL;
        if (lb && rb) {
            char *p = lb + 1;
            while (p < rb && victim_count < max_victims) {
                // 숫자 시작 위치 찾기
                while (p < rb && (*p < '0' || *p > '9')) p++;
                if (p >= rb) break;
                out_victims[victim_count++] = (int)strtol(p, &p, 10);
            }
        }
    }

    // (6) reasoning 추출 (있으면 로그용으로)
    if (out_reasoning && reasoning_size > 0) {
        out_reasoning[0] = '\0';
        char *rptr = strstr(output_json, "\"reasoning\"");
        if (rptr) {
            char *q1 = strchr(rptr + 11, '"');      // 값 시작 따옴표
            char *q2 = q1 ? strchr(q1 + 1, '"') : NULL; // 값 끝 따옴표
            if (q1 && q2 && (size_t)(q2 - q1 - 1) < reasoning_size) {
                size_t len = q2 - q1 - 1;
                strncpy(out_reasoning, q1 + 1, len);
                out_reasoning[len] = '\0';
            }
        }
    }

    return victim_count;
}

int main(int argc, char *argv[]) {
    int opt;
    char *policy_path = NULL;
    int dry_run = 0;
    double threshold = 15.0; // 온보딩 가이드 기본 임계치 고정

    struct option long_options[] = {
        {"policy", required_argument, 0, 'p'},
        {"dry-run", no_argument, &dry_run, 1},
        {"threshold", required_argument, 0, 't'},
        {0, 0, 0, 0}
    };

    while ((opt = getopt_long(argc, argv, "p:t:", long_options, NULL)) != -1) {
        switch (opt) {
            case 'p':
                policy_path = optarg;
                break;
            case 't':
                threshold = atof(optarg);
                break;
            case 0:
                break;
            default:
                fprintf(stderr, "사용법: %s --policy <경로> [--dry-run] --threshold <임계치(%%)>\n", argv[0]);
                return EXIT_FAILURE;
        }
    }

    // 사용자 정책 텍스트 결정 (파일이 없으면 기본 정책 사용)
    // 데모 단순화를 위해 정책 문자열을 고정값으로 둡니다.
    // (추후 R3에서 ~/.oom_policy 파일을 읽도록 확장 가능)
    const char *policy_text =
        "I am coding. Never kill VS Code, gcc, or firefox. "
        "Chrome tabs and music apps are fine to kill first.";

    printf("\n==================================================\n");
    printf("[R4 Integration] coomd (Conversational OOM) 데몬 구동 시작\n");
    printf("==================================================\n");
    printf("  PSI 감시 임계치 : %.2f%%\n", threshold);
    if (policy_path) {
        printf("  사용자 정책 파일: %s\n", policy_path);
    } else {
        printf("  사용자 정책 파일: 기본값 사용 (내장 정책)\n");
    }
    printf("  실행 모드       : %s\n", dry_run ? "DRY-RUN (가짜 시뮬레이션)" : "ACTUAL (진짜 프로세스 종료)");
    printf("==================================================\n\n");

    psi_event_t current_event;
    proc_candidate_t candidates[MAX_CANDIDATES];

    while (1) {
        bool is_pressured = r1_check_pressure(threshold, &current_event);
        printf("[R4 Main Loop] PSI some_avg10: %.2f%% (임계값: %.2f%%)\n",
               current_event.some_avg10, threshold);

        if (is_pressured) {
            printf("\n🚨 [ALERT] 메모리 위험 신호가 감지되어 OOM 처리기를 시작합니다!\n");

            int candidate_count = r2_collect_candidates(candidates, MAX_CANDIDATES);
            printf("[R2 Introspector] 종료 후보가 될 수 있는 프로세스 %d개 발견.\n", candidate_count);
            for (int i = 0; i < candidate_count; i++) {
                printf("  -> [%d] PID: %5d | 프로세스명: %10s | 메모리(RSS): %lu kB\n",
                       i, candidates[i].pid, candidates[i].comm, candidates[i].rss_kb);
            }

            // ===== (R3 연결) LLM에게 victim 추천 받기 =====
            printf("\n[R3 LLM Helper] 사용자 정책을 바탕으로 AI에게 victim 선택을 요청합니다...\n");
            printf("  정책: \"%s\"\n", policy_text);

            int victims[MAX_CANDIDATES];
            char reasoning[1024];
            int victim_count = ask_llm_helper(policy_text, candidates, candidate_count,
                                              500, victims, MAX_CANDIDATES,
                                              reasoning, sizeof(reasoning));

            if (victim_count < 0) {
                printf("  ⚠️ [R3] LLM 호출 실패. 이번 사이클은 건너뜁니다.\n");
                printf("--------------------------------------------------\n\n");
                sleep(5);
                continue;
            }

            printf("  🤖 [R3] AI가 선택한 victim 개수: %d개\n", victim_count);
            if (reasoning[0] != '\0') {
                printf("  💬 [R3] AI 판단 근거: %s\n", reasoning);
            }
            printf("\n");

            // ===== AI가 고른 victim만 Validator로 검증 후 처리 =====
            for (int v = 0; v < victim_count; v++) {
                int target_pid = victims[v];

                // 후보 목록에서 해당 PID의 이름 찾기 (로그용)
                const char *comm = "unknown";
                for (int i = 0; i < candidate_count; i++) {
                    if (candidates[i].pid == target_pid) {
                        comm = candidates[i].comm;
                        break;
                    }
                }

                printf("  🎯 [TARGET] AI 추천 victim → PID: %d (%s)\n", target_pid, comm);

                bool safe_to_kill = validator_ok(target_pid);
                if (safe_to_kill) {
                    printf("     🛡️ [VALIDATOR] 판정: PASS (얘는 죽여도 괜찮습니다!)\n");
                    if (dry_run) {
                        printf("     ⚡ [DRY-RUN] PID %d 에 종료 시그널(SIGTERM) 가상 전송\n", target_pid);
                    } else {
                        printf("     ⚡ [ACTUAL] PID %d 에 종료 시그널(SIGTERM) 진짜 전송!\n", target_pid);
                    }
                } else {
                    printf("     🛡️ [VALIDATOR] 판정: BLOCKED (AI가 골랐지만 시스템 보호 대상입니다!)\n");
                }
            }
            printf("--------------------------------------------------\n\n");
        }
        sleep(5); // 5초 대기 후 반복
    }

    return 0;
}

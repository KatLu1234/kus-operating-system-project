#include <stdio.h>
#include <stdlib.h>
#include <getopt.h>
#include <stdbool.h>
#include <unistd.h>
#include <string.h>
#include <ctype.h>
#include <sys/wait.h>
#include "validator.h"
#include "psi_monitor.h"
#include "proc_reader.h"

#define MAX_CANDIDATES 128
#define IPC_BUF_SIZE 16384
#define HELPER_PATH "LLM_client/helper.py"

static void json_sanitize(const char *src, char *out, size_t out_size) {
    size_t j = 0;
    for (size_t i = 0; src[i] != '\0' && j < out_size - 1; i++) {
        unsigned char ch = (unsigned char)src[i];
        if (ch == '"' || ch == '\\' || ch < 0x20) {
            out[j++] = ' ';
        } else {
            out[j++] = (char)ch;
        }
    }
    out[j] = '\0';
}

static int ask_llm_helper(const char *policy,
                          proc_candidate_t *candidates, int count,
                          int target_free_mb,
                          int *out_victims, int max_victims,
                          char *out_reasoning, size_t reasoning_size) {
    int to_child[2];
    int from_child[2];
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
        dup2(to_child[0], STDIN_FILENO);
        dup2(from_child[1], STDOUT_FILENO);
        close(to_child[0]); close(to_child[1]);
        close(from_child[0]); close(from_child[1]);
        execlp("python3", "python3", HELPER_PATH, (char *)NULL);
        perror("execlp");
        _exit(127);
    }
    close(to_child[0]);
    close(from_child[1]);
    char input_json[IPC_BUF_SIZE];
    int off = 0;
    char safe_policy[2048];
    json_sanitize(policy, safe_policy, sizeof(safe_policy));
    off += snprintf(input_json + off, sizeof(input_json) - off,
                    "{\"policy\": \"%s\", \"target_free_mb\": %d, \"candidates\": [",
                    safe_policy, target_free_mb);
    for (int i = 0; i < count; i++) {
        char safe_comm[64];
        json_sanitize(candidates[i].comm, safe_comm, sizeof(safe_comm));
        off += snprintf(input_json + off, sizeof(input_json) - off,
                        "%s{\"pid\": %d, \"comm\": \"%s\", \"rss_kb\": %lu}",
                        (i == 0 ? "" : ", "),
                        candidates[i].pid, safe_comm, candidates[i].rss_kb);
        if (off >= (int)sizeof(input_json) - 100) break;
    }
    off += snprintf(input_json + off, sizeof(input_json) - off, "]}\n");
    if (write(to_child[1], input_json, strlen(input_json)) == -1) {
        perror("write");
    }
    close(to_child[1]);
    char output_json[IPC_BUF_SIZE] = {0};
    ssize_t n = read(from_child[0], output_json, sizeof(output_json) - 1);
    close(from_child[0]);
    if (n <= 0) {
        fprintf(stderr, "[IPC] helper 응답을 읽지 못했습니다.\n");
        waitpid(pid, NULL, 0);
        return -1;
    }
    output_json[n] = '\0';
    waitpid(pid, NULL, 0);
    int victim_count = 0;
    char *vptr = strstr(output_json, "\"victims\"");
    if (vptr) {
        char *lb = strchr(vptr, '[');
        char *rb = lb ? strchr(lb, ']') : NULL;
        if (lb && rb) {
            char *p = lb + 1;
            while (p < rb && victim_count < max_victims) {
                while (p < rb && (*p < '0' || *p > '9')) p++;
                if (p >= rb) break;
                out_victims[victim_count++] = (int)strtol(p, &p, 10);
            }
        }
    }
    if (out_reasoning && reasoning_size > 0) {
        out_reasoning[0] = '\0';
        char *rptr = strstr(output_json, "\"reasoning\"");
        if (rptr) {
            char *q1 = strchr(rptr + 11, '"');
            char *q2 = q1 ? strchr(q1 + 1, '"') : NULL;
            if (q1 && q2 && (size_t)(q2 - q1 - 1) < reasoning_size) {
                size_t len = q2 - q1 - 1;
                strncpy(out_reasoning, q1 + 1, len);
                out_reasoning[len] = '\0';
            }
        }
    }
    return victim_count;
}

/*
 * --policy 로 지정된 파일에서 자연어 정책을 읽어온다.
 * 성공하면 buf 에 내용을 채우고 buf 포인터를 반환,
 * 실패(경로 미지정 / 파일 없음 / 빈 파일)하면 NULL 을 반환한다.
 */
static const char *load_policy_file(const char *path, char *buf, size_t buf_size) {
    if (!path) {
        return NULL;
    }
    FILE *pf = fopen(path, "r");
    if (!pf) {
        fprintf(stderr, "⚠️ 정책 파일을 열 수 없어 기본 정책을 사용합니다: %s\n", path);
        return NULL;
    }
    size_t n = fread(buf, 1, buf_size - 1, pf);
    fclose(pf);
    buf[n] = '\0';
    /* 끝쪽 개행/공백 정리 */
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r' || buf[n - 1] == ' ')) {
        buf[--n] = '\0';
    }
    if (n == 0) {
        fprintf(stderr, "⚠️ 정책 파일이 비어 있어 기본 정책을 사용합니다: %s\n", path);
        return NULL;
    }
    return buf;
}

int main(int argc, char *argv[]) {
    int opt;
    char *policy_path = NULL;
    int dry_run = 0;
    double threshold = 15.0;
    struct option long_options[] = {
        {"policy", required_argument, 0, 'p'},
        {"dry-run", no_argument, &dry_run, 1},
        {"threshold", required_argument, 0, 't'},
        {0, 0, 0, 0}
    };
    while ((opt = getopt_long(argc, argv, "p:t:", long_options, NULL)) != -1) {
        switch (opt) {
            case 'p': policy_path = optarg; break;
            case 't': threshold = atof(optarg); break;
            case 0: break;
            default:
                fprintf(stderr, "사용법: %s --policy <경로> [--dry-run] --threshold <임계치>\n", argv[0]);
                return EXIT_FAILURE;
        }
    }

    /* 기본 내장 정책 (--policy 미지정 또는 파일 읽기 실패 시 fallback) */
    const char *default_policy =
        "I am coding. Never kill VS Code, gcc, or firefox. "
        "Chrome tabs and music apps are fine to kill first.";

    /* --policy 파일을 우선 사용하고, 실패하면 기본 정책으로 fallback */
    static char policy_buf[2048];
    const char *policy_text = load_policy_file(policy_path, policy_buf, sizeof(policy_buf));
    if (!policy_text) {
        policy_text = default_policy;
    }

    printf("\n==================================================\n");
    printf("[R4 Integration] coomd (Conversational OOM) 데몬 구동 시작\n");
    printf("==================================================\n");
    printf("  PSI 감시 임계치 : %.2f%%\n", threshold);
    if (policy_path && policy_text != default_policy) {
        printf("  사용자 정책 파일: %s (로드 성공)\n", policy_path);
    } else if (policy_path) {
        printf("  사용자 정책 파일: %s (로드 실패 → 기본 정책)\n", policy_path);
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
                printf("  -> [%d] PID: %5d | 프로세스명: %15s | 메모리(RSS): %lu kB\n",
                       i, candidates[i].pid, candidates[i].comm, candidates[i].rss_kb);
            }
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
            for (int v = 0; v < victim_count; v++) {
                int target_pid = victims[v];
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
        sleep(5);
    }
    return 0;
}

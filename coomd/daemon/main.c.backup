#include <stdio.h>
#include <stdlib.h>
#include <getopt.h>
#include <stdbool.h>
#include <unistd.h>

// 꼬임 방지를 위해 현재 폴더(coomd/daemon) 안의 헤더파일을 확실히 가리키도록 설정합니다.
#include "validator.h"
#include "psi_monitor.h"
#include "proc_reader.h"

#define MAX_CANDIDATES 128

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

    printf("\n==================================================\n");
    printf("[R4 Integration] coomd (Conversational OOM) 데몬 구동 시작\n");
    printf("==================================================\n");
    printf("  PSI 감시 임계치 : %.2f%%\n", threshold);
    if (policy_path) {
        printf("  사용자 정책 파일: %s\n", policy_path);
    } else {
        printf("  사용자 정책 파일: 기본값 사용 (~/.oom_policy)\n");
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
                
                // Validator로 검증해보기!
                bool safe_to_kill = validator_ok(candidates[i].pid);
                if (safe_to_kill) {
                    printf("     🛡️ [VALIDATOR] 판정: PASS (얘는 죽여도 괜찮습니다!)\n");
                    if (dry_run) {
                        printf("     ⚡ [DRY-RUN] PID %d 에 종료 시그널(SIGTERM) 가상 전송\n", candidates[i].pid);
                    } else {
                        printf("     ⚡ [ACTUAL] PID %d 에 종료 시그널(SIGTERM) 진짜 전송!\n", candidates[i].pid);
                    }
                } else {
                    printf("     🛡️ [VALIDATOR] 판정: BLOCKED (절대 안됩니다! 시스템 망가집니다!)\n");
                }
            }
            printf("--------------------------------------------------\n\n");
        }

        sleep(5); // 5초 대기 후 반복
    }

    return 0;
}
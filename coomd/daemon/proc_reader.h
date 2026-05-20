#ifndef PROC_READER_H
#define PROC_READER_H

#include <sys/types.h>
#include <string.h>

// 프로세스 명함 양식입니다.
typedef struct {
    pid_t pid;
    char comm[16];
    char cmdline[256];
    unsigned long rss_kb;
    uid_t uid;
    pid_t ppid;
} proc_candidate_t;

static inline int r2_collect_candidates(proc_candidate_t *list, int max_size) {
    if (max_size < 3) return 0;

    // 1번 용의자: 크롬 
    list[0].pid = 9999;
    list[0].rss_kb = 1245000;
    list[0].uid = 1000;
    list[0].ppid = 2000;
    strncpy(list[0].comm, "chrome", sizeof(list[0].comm));
    strncpy(list[0].cmdline, "/usr/bin/chrome --renderer", sizeof(list[0].cmdline));

    // 2번 용의자: 파이어폭스
    list[1].pid = 8888;
    list[1].rss_kb = 512000;
    list[1].uid = 1000;
    list[1].ppid = 2000;
    strncpy(list[1].comm, "firefox", sizeof(list[1].comm));
    strncpy(list[1].cmdline, "/usr/bin/firefox", sizeof(list[1].cmdline));

    // 3번 용의자: systemd 
    list[2].pid = 1;
    list[2].rss_kb = 4096;
    list[2].uid = 0;
    list[2].ppid = 0;
    strncpy(list[2].comm, "systemd", sizeof(list[2].comm));
    strncpy(list[2].cmdline, "/sbin/init", sizeof(list[2].cmdline));

    return 3;
}

#endif /* PROC_READER_H */
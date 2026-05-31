#ifndef PROC_READER_H
#define PROC_READER_H

#include <sys/types.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <dirent.h>
#include <ctype.h>

typedef struct {
    pid_t pid;
    char comm[16];
    char cmdline[256];
    unsigned long rss_kb;
    uid_t uid;
    pid_t ppid;
} proc_candidate_t;

static inline int r2_is_number(const char *s) {
    if (!s || !*s) return 0;
    for (const char *p = s; *p; p++) {
        if (!isdigit((unsigned char)*p)) return 0;
    }
    return 1;
}

static inline int r2_read_status(pid_t pid, proc_candidate_t *c) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/status", pid);
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    c->pid = pid;
    c->comm[0] = '\0';
    c->rss_kb = 0;
    c->uid = 0;
    c->ppid = 0;
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        if (strncmp(line, "Name:", 5) == 0) {
            sscanf(line + 5, "%15s", c->comm);
        } else if (strncmp(line, "VmRSS:", 6) == 0) {
            sscanf(line + 6, "%lu", &c->rss_kb);
        } else if (strncmp(line, "Uid:", 4) == 0) {
            sscanf(line + 4, "%u", &c->uid);
        } else if (strncmp(line, "PPid:", 5) == 0) {
            sscanf(line + 5, "%d", &c->ppid);
        }
    }
    fclose(f);
    return 1;
}

static inline void r2_read_cmdline(pid_t pid, proc_candidate_t *c) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/cmdline", pid);
    c->cmdline[0] = '\0';
    FILE *f = fopen(path, "r");
    if (!f) return;
    size_t n = fread(c->cmdline, 1, sizeof(c->cmdline) - 1, f);
    fclose(f);
    if (n == 0) {
        snprintf(c->cmdline, sizeof(c->cmdline), "[%s]", c->comm);
        return;
    }
    for (size_t i = 0; i < n; i++) {
        if (c->cmdline[i] == '\0') c->cmdline[i] = ' ';
    }
    c->cmdline[n] = '\0';
}

static inline int r2_collect_candidates(proc_candidate_t *list, int max_size) {
    enum { R2_TMP_MAX = 1024 };
    static proc_candidate_t tmp[R2_TMP_MAX];
    int count = 0;
    DIR *proc = opendir("/proc");
    if (!proc) return 0;
    struct dirent *entry;
    while ((entry = readdir(proc)) != NULL && count < R2_TMP_MAX) {
        if (!r2_is_number(entry->d_name)) continue;
        pid_t pid = (pid_t)strtol(entry->d_name, NULL, 10);
        proc_candidate_t c;
        if (!r2_read_status(pid, &c)) continue;
        if (c.rss_kb == 0) continue;
        r2_read_cmdline(pid, &c);
        tmp[count++] = c;
    }
    closedir(proc);
    int limit = (count < max_size) ? count : max_size;
    for (int i = 0; i < limit; i++) {
        int max_idx = i;
        for (int j = i + 1; j < count; j++) {
            if (tmp[j].rss_kb > tmp[max_idx].rss_kb) {
                max_idx = j;
            }
        }
        proc_candidate_t t = tmp[i];
        tmp[i] = tmp[max_idx];
        tmp[max_idx] = t;
        list[i] = tmp[i];
    }
    return limit;
}

#endif /* PROC_READER_H */

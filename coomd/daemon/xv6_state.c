// xv6_state.c — read the live xv6 kernel snapshot from the bridge file.
//
// This is the module that makes coomd reflect REAL xv6 data instead of the
// old mock (psi_monitor.h / proc_reader.h). The interface parses xv6's
// "@@STAT {json}" console stream and writes a compact, line-oriented bridge
// file (coomd/.xv6_state); we parse it back here. See xv6_state.h.

#include "xv6_state.h"

#include <stdio.h>
#include <string.h>
#include <time.h>
#include <sys/stat.h>

int
xv6_read_state(const char *path, xv6_psi_t *psi,
               xv6_proc_t *procs, int max, int max_age_sec)
{
    psi->psi_some = 0;
    psi->psi_full = 0;
    psi->fresh    = false;

    // Stat first: distinguish "not created yet" from "exists but stale".
    struct stat st;
    if (stat(path, &st) != 0)
        return -1;                          // bridge file not present yet

    FILE *f = fopen(path, "r");
    if (!f)
        return -2;

    // Freshness: the interface rewrites this file on every @@STAT (~1/s). If
    // it has not been touched within max_age_sec, xv6 is no longer reporting.
    if (max_age_sec > 0) {
        time_t now = time(NULL);
        psi->fresh = (now - st.st_mtime) <= max_age_sec;
    } else {
        psi->fresh = true;                  // freshness check disabled
    }

    int count = 0;
    char line[512];
    while (fgets(line, sizeof(line), f)) {
        if (strncmp(line, "PSI ", 4) == 0) {
            // "PSI <some> <full>"
            int some = 0, full = 0;
            if (sscanf(line + 4, "%d %d", &some, &full) >= 1) {
                psi->psi_some = some;
                psi->psi_full = full;
            }
        } else if (strncmp(line, "PROC ", 5) == 0) {
            // "PROC <pid> <rss_kb> <name>"
            if (count >= max)
                continue;                   // keep draining so PSI stays valid
            int pid = 0;
            unsigned long rss = 0;
            char name[16] = {0};
            // %15[^\n] grabs the rest of the line as the name (may contain
            // nothing useful past 15 chars; xv6 names are <= 15 chars anyway).
            if (sscanf(line + 5, "%d %lu %15[^\n]", &pid, &rss, name) >= 2) {
                procs[count].pid    = pid;
                procs[count].rss_kb = rss;
                // Trim a trailing space the format string can leave behind.
                size_t n = strlen(name);
                while (n > 0 && (name[n - 1] == ' ' || name[n - 1] == '\r'))
                    name[--n] = '\0';
                snprintf(procs[count].name, sizeof(procs[count].name),
                         "%s", name);
                count++;
            }
        }
        // any other line (blank, unknown tag) is ignored
    }

    fclose(f);
    return count;
}

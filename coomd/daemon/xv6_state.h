#ifndef XV6_STATE_H
#define XV6_STATE_H

#include <stdbool.h>

// One process candidate, exported from the live xv6 kernel.
//
// This replaces the old hard-coded chrome/firefox/systemd mock in
// proc_reader.h. Every field here comes from a REAL xv6 process, bridged
// out of the kernel by statd's "@@STAT {json}" stream:
//
//     xv6  -> statd        prints  "@@STAT {...,procs:[{pid,name,sz_kb,...}]}"
//     host -> interface    parses @@STAT, writes coomd/.xv6_state
//     host -> coomd        reads   coomd/.xv6_state  (this struct)
//
typedef struct {
    int           pid;
    char          name[16];     // xv6 process name (p->name)
    unsigned long rss_kb;       // process memory size, KiB (p->sz / 1024)
} xv6_proc_t;

// A pressure + process snapshot read from the bridge file in one shot.
typedef struct {
    int  psi_some;              // some_avg10 as an integer percent (0..100)
    int  psi_full;              // full_avg10 as an integer percent (0..100)
    bool fresh;                 // true if the bridge file was recent enough
} xv6_psi_t;

// Read the live xv6 snapshot from the bridge file `path`.
//
// The bridge file is written atomically by the interface (xv6-interface/
// main.js -> writeXv6StateForCoomd). Its format is one record per line:
//
//     PSI  <some> <full>
//     PROC <pid> <rss_kb> <name>
//     PROC <pid> <rss_kb> <name>
//     ...
//
// Fills *psi with the PSI line and *procs (up to max) with the PROC lines.
// `max_age_sec` guards against a stale file (xv6 stopped reporting): if the
// file's mtime is older than that, psi->fresh is set false.
//
// Returns the number of candidates written to `procs` (>= 0), or:
//   -1  the file does not exist yet (xv6 / interface not up)
//   -2  the file could not be opened/read
//
// On any negative return, *psi is zeroed (psi->fresh == false).
int xv6_read_state(const char *path, xv6_psi_t *psi,
                   xv6_proc_t *procs, int max, int max_age_sec);

#endif /* XV6_STATE_H */

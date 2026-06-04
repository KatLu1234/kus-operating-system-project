// coomd — Conversational OOM killer (host-side daemon).
//
// WHAT CHANGED (rebuild): coomd no longer invents data. It reflects the REAL
// xv6 kernel by reading the live bridge file the interface writes from xv6's
// "@@STAT" stream (see xv6_state.c). The old psi_monitor.h (fake 16.5% PSI)
// and proc_reader.h (fake chrome/firefox/systemd) are gone.
//
// PIPELINE
//   xv6 kernel ─statd──▶ "@@STAT {json}" ─interface──▶ coomd/.xv6_state
//                                                          │ (this daemon)
//                              read PSI + real candidates ◀┘
//                                          │ pressured?
//                                          ▼
//                       fork+exec+pipe ──▶ LLM_client/helper.py (Upstage Solar)
//                                          │  {"victims":[...],"reasoning":...}
//                                          ▼
//                              validate ──▶ report decision (EVENT lines)
//
// NOTE ON KILLING: the candidates live INSIDE xv6 (QEMU). This host daemon
// cannot signal them — the real kill is done by xv6's own `oomd` via the
// @@OOM_REQ/@@OOM_RESP path. So coomd runs as a parallel monitor/decider and
// REPORTS its decision (the interface marks the matching service cards). It is
// launched with --dry-run for exactly this reason.
//
// STDOUT CONTRACT (consumed by xv6-interface/main.js -> renderer.js):
//   EVENT {"kind":"startup",  "threshold":..,"dry_run":..}
//   EVENT {"kind":"pressure", "some_avg10":..,"some_avg60":..,"full_avg10":..,
//                             "threshold":..,"pressured":..}
//   EVENT {"kind":"decision", "source":"coomd","engine":..,"victims":[..],
//                             "reasoning":..,"psi":..,"candCount":..}
//   EVENT {"kind":"kill",     "pid":..,"comm":..,"signal":"SIGTERM","dry_run":..}
//   EVENT {"kind":"blocked",  "pid":..,"comm":..}
//   EVENT {"kind":"error",    "stage":..,"message":..}
// Any non-"EVENT " line is treated as a plain log line by the interface.

#include <stdio.h>
#include <stdlib.h>
#include <getopt.h>
#include <stdbool.h>
#include <unistd.h>
#include <string.h>
#include <sys/wait.h>

#include "xv6_state.h"
#include "validator.h"

#define MAX_CANDIDATES   128
#define IPC_BUF_SIZE     8192
#define REASONING_SIZE   1024

// Defaults (overridable via flags / env).
#define DEFAULT_STATE_FILE  ".xv6_state"                 // relative to cwd (coomd/)
#define DEFAULT_HELPER      "LLM_client/helper.py"
#define DEFAULT_THRESHOLD   15.0
#define DEFAULT_INTERVAL    2                            // seconds between reads
#define DEFAULT_MAX_AGE     10                           // bridge staleness (s)
#define TARGET_FREE_MB      64

// ── tiny JSON string escaper ────────────────────────────────────────────────
// Escapes ", \, and control chars so we can safely embed names/reasoning/policy
// into the JSON we print and the JSON we send to helper.py.
static void
json_escape(char *dst, size_t cap, const char *src)
{
    size_t o = 0;
    if (cap == 0) return;
    for (const char *p = src ? src : ""; *p && o + 2 < cap; p++) {
        unsigned char c = (unsigned char)*p;
        if (c == '"' || c == '\\') {
            dst[o++] = '\\';
            dst[o++] = c;
        } else if (c == '\n') {
            dst[o++] = '\\'; dst[o++] = 'n';
        } else if (c == '\r') {
            dst[o++] = '\\'; dst[o++] = 'r';
        } else if (c == '\t') {
            dst[o++] = '\\'; dst[o++] = 't';
        } else if (c < 0x20) {
            // drop other control chars
        } else {
            dst[o++] = (char)c;
        }
    }
    dst[o] = '\0';
}

// ── LLM helper IPC (fork + exec + 2 pipes) ──────────────────────────────────
// Sends {policy, target_free_mb, candidates:[{pid,comm,rss_kb}]} to helper.py
// on its stdin, reads {"victims":[...],"reasoning":"..."} from its stdout.
// Returns victim count (>=0), or -1 on failure. Fills out_victims/out_reasoning.
static int
ask_llm_helper(const char *helper_path, const char *policy,
               xv6_proc_t *cand, int count, int target_free_mb,
               int *out_victims, int max_victims,
               char *out_reasoning, size_t reasoning_size)
{
    int to_child[2], from_child[2];
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
        // child: become `python3 helper.py`
        dup2(to_child[0], STDIN_FILENO);
        dup2(from_child[1], STDOUT_FILENO);
        close(to_child[0]); close(to_child[1]);
        close(from_child[0]); close(from_child[1]);
        execlp("python3", "python3", helper_path, (char *)NULL);
        perror("execlp");
        _exit(127);
    }

    // parent
    close(to_child[0]);
    close(from_child[1]);

    // (1) build input JSON from the REAL xv6 candidates
    char pol_esc[2048];
    json_escape(pol_esc, sizeof(pol_esc), policy);

    char input_json[IPC_BUF_SIZE];
    int off = 0;
    off += snprintf(input_json + off, sizeof(input_json) - off,
                    "{\"policy\": \"%s\", \"target_free_mb\": %d, \"candidates\": [",
                    pol_esc, target_free_mb);
    for (int i = 0; i < count && off < (int)sizeof(input_json) - 64; i++) {
        char name_esc[64];
        json_escape(name_esc, sizeof(name_esc), cand[i].name);
        off += snprintf(input_json + off, sizeof(input_json) - off,
                        "%s{\"pid\": %d, \"comm\": \"%s\", \"rss_kb\": %lu}",
                        (i == 0 ? "" : ", "),
                        cand[i].pid, name_esc, cand[i].rss_kb);
    }
    off += snprintf(input_json + off, sizeof(input_json) - off, "]}\n");

    // (2) write JSON to child stdin, then close so it sees EOF
    if (write(to_child[1], input_json, strlen(input_json)) == -1)
        perror("write");
    close(to_child[1]);

    // (3) read child's reply
    char output_json[IPC_BUF_SIZE] = {0};
    size_t total = 0;
    ssize_t n;
    while (total < sizeof(output_json) - 1 &&
           (n = read(from_child[0], output_json + total,
                     sizeof(output_json) - 1 - total)) > 0)
        total += (size_t)n;
    close(from_child[0]);
    output_json[total] = '\0';
    waitpid(pid, NULL, 0);

    if (total == 0)
        return -1;

    // (4) parse "victims": [ ... ]
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

    // (5) parse "reasoning": "..."
    if (out_reasoning && reasoning_size > 0) {
        out_reasoning[0] = '\0';
        char *rptr = strstr(output_json, "\"reasoning\"");
        if (rptr) {
            char *q1 = strchr(rptr + 11, '"');
            char *q2 = q1 ? strchr(q1 + 1, '"') : NULL;
            if (q1 && q2 && (size_t)(q2 - q1 - 1) < reasoning_size) {
                size_t len = q2 - q1 - 1;
                memcpy(out_reasoning, q1 + 1, len);
                out_reasoning[len] = '\0';
            }
        }
    }

    return victim_count;
}

// ── policy text assembly ────────────────────────────────────────────────────
static char policy_buf[4096];

static const char *
build_policy(const char *policy_path)
{
    // 1) explicit --policy file wins
    if (policy_path) {
        FILE *f = fopen(policy_path, "r");
        if (f) {
            size_t n = fread(policy_buf, 1, sizeof(policy_buf) - 1, f);
            fclose(f);
            policy_buf[n] = '\0';
            // trim trailing newline
            while (n > 0 && (policy_buf[n - 1] == '\n' || policy_buf[n - 1] == '\r'))
                policy_buf[--n] = '\0';
            if (policy_buf[0])
                return policy_buf;
        }
    }

    // 2) base policy from env, else a sensible xv6 default
    const char *base = getenv("OOM_POLICY");
    if (!base || !base[0])
        base = "Keep init, the shell (sh), statd and oomd alive. "
               "Memory-hungry services are fine to kill to relieve pressure.";

    const char *purpose = getenv("SERVER_PURPOSE");
    if (purpose && purpose[0]) {
        snprintf(policy_buf, sizeof(policy_buf),
                 "%s\nThe operator described this server's purpose as: \"%s\". "
                 "Honor that purpose: protect processes essential to it and "
                 "prefer killing ones that are not.", base, purpose);
    } else {
        snprintf(policy_buf, sizeof(policy_buf), "%s", base);
    }
    return policy_buf;
}

int
main(int argc, char *argv[])
{
    char  *policy_path = NULL;
    int    dry_run     = 0;
    double threshold   = DEFAULT_THRESHOLD;
    int    interval    = DEFAULT_INTERVAL;
    int    max_age     = DEFAULT_MAX_AGE;
    int    run_once    = 0;

    const char *state_file = getenv("COOMD_XV6_STATE");
    if (!state_file || !state_file[0]) state_file = DEFAULT_STATE_FILE;

    const char *helper_path = getenv("COOMD_HELPER");
    if (!helper_path || !helper_path[0]) helper_path = DEFAULT_HELPER;

    struct option long_options[] = {
        {"policy",    required_argument, 0,        'p'},
        {"dry-run",   no_argument,       &dry_run,  1 },
        {"threshold", required_argument, 0,        't'},
        {"state",     required_argument, 0,        's'},
        {"interval",  required_argument, 0,        'i'},
        {"max-age",   required_argument, 0,        'a'},
        {"once",      no_argument,       &run_once, 1 },
        {0, 0, 0, 0}
    };

    int opt;
    while ((opt = getopt_long(argc, argv, "p:t:s:i:a:", long_options, NULL)) != -1) {
        switch (opt) {
            case 'p': policy_path = optarg;          break;
            case 't': threshold   = atof(optarg);    break;
            case 's': state_file  = optarg;          break;
            case 'i': interval    = atoi(optarg);    break;
            case 'a': max_age     = atoi(optarg);    break;
            case 0:                                  break;
            default:
                fprintf(stderr,
                  "usage: %s [--policy <file>] [--dry-run] [--threshold <pct>] "
                  "[--state <file>] [--interval <s>] [--max-age <s>] [--once]\n",
                  argv[0]);
                return EXIT_FAILURE;
        }
    }
    if (interval < 1) interval = 1;

    const char *policy_text = build_policy(policy_path);

    // line-buffered stdout so the interface sees EVENT lines immediately
    setvbuf(stdout, NULL, _IOLBF, 0);

    printf("[coomd] started — reading REAL xv6 state from \"%s\"\n", state_file);
    printf("[coomd] threshold=%.1f%%  interval=%ds  mode=%s\n",
           threshold, interval, dry_run ? "DRY-RUN" : "ACTIVE");
    printf("[coomd] policy: %s\n", policy_text);
    printf("EVENT {\"kind\":\"startup\",\"threshold\":%.1f,\"dry_run\":%d}\n",
           threshold, dry_run ? 1 : 0);

    xv6_psi_t  psi;
    xv6_proc_t cand[MAX_CANDIDATES];

    int   warned_missing = 0;     // throttle "waiting for bridge" spam
    int   warned_stale   = 0;

    for (;;) {
        int n = xv6_read_state(state_file, &psi, cand, MAX_CANDIDATES, max_age);

        if (n < 0) {
            if (!warned_missing) {
                printf("[coomd] waiting for xv6 state — bridge file not found yet "
                       "(%s). Is the interface (or statd) running?\n", state_file);
                warned_missing = 1;
            }
            if (run_once) break;
            sleep(interval);
            continue;
        }
        warned_missing = 0;

        if (!psi.fresh) {
            if (!warned_stale) {
                printf("[coomd] xv6 state is stale (no update in >%ds) — "
                       "xv6 may have stopped reporting.\n", max_age);
                warned_stale = 1;
            }
            if (run_once) break;
            sleep(interval);
            continue;
        }
        warned_stale = 0;

        bool pressured = (double)psi.psi_some > threshold;

        // Always surface PSI so the host-side OOM panel tracks real xv6 pressure.
        // The bridge carries only avg10; reuse it for the avg60 slot.
        printf("EVENT {\"kind\":\"pressure\",\"some_avg10\":%d,\"some_avg60\":%d,"
               "\"full_avg10\":%d,\"threshold\":%.1f,\"pressured\":%s}\n",
               psi.psi_some, psi.psi_some, psi.psi_full, threshold,
               pressured ? "true" : "false");

        if (pressured) {
            printf("[coomd] PRESSURE psi_some=%d%% > %.1f%% — %d live xv6 candidates\n",
                   psi.psi_some, threshold, n);
            for (int i = 0; i < n; i++)
                printf("[coomd]   pid=%-4d %-12s %lu kB\n",
                       cand[i].pid, cand[i].name, cand[i].rss_kb);

            int  victims[MAX_CANDIDATES];
            char reasoning[REASONING_SIZE];
            int  vc = ask_llm_helper(helper_path, policy_text, cand, n,
                                     TARGET_FREE_MB, victims, MAX_CANDIDATES,
                                     reasoning, sizeof(reasoning));

            if (vc < 0) {
                printf("EVENT {\"kind\":\"error\",\"stage\":\"llm\","
                       "\"message\":\"helper.py call failed\"}\n");
            } else {
                char reason_esc[REASONING_SIZE * 2];
                json_escape(reason_esc, sizeof(reason_esc), reasoning);

                // decision summary (interface marks matching service cards)
                printf("EVENT {\"kind\":\"decision\",\"source\":\"coomd\","
                       "\"engine\":\"llm\",\"psi\":%d,\"candCount\":%d,"
                       "\"reasoning\":\"%s\",\"victims\":[",
                       psi.psi_some, n, reason_esc);
                for (int v = 0; v < vc; v++)
                    printf("%s%d", v ? "," : "", victims[v]);
                printf("]}\n");

                // per-victim validation + (dry-run) action
                for (int v = 0; v < vc; v++) {
                    int target = victims[v];
                    const char *comm = "unknown";
                    for (int i = 0; i < n; i++)
                        if (cand[i].pid == target) { comm = cand[i].name; break; }

                    char comm_esc[64];
                    json_escape(comm_esc, sizeof(comm_esc), comm);

                    if (validator_ok(target, comm)) {
                        printf("EVENT {\"kind\":\"kill\",\"pid\":%d,\"comm\":\"%s\","
                               "\"signal\":\"SIGTERM\",\"dry_run\":%d}\n",
                               target, comm_esc, dry_run ? 1 : 0);
                        printf("[coomd] %s victim pid=%d (%s)\n",
                               dry_run ? "would kill" : "selected", target, comm);
                    } else {
                        printf("EVENT {\"kind\":\"blocked\",\"pid\":%d,\"comm\":\"%s\"}\n",
                               target, comm_esc);
                        printf("[coomd] BLOCKED pid=%d (%s) — protected\n",
                               target, comm);
                    }
                }
            }
        }

        if (run_once) break;
        sleep(interval);
    }

    return 0;
}

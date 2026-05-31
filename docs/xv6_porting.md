# Porting to xv6-riscv: Design Sketch

This section presents a design sketch of how the same mechanism would be structured if ported to the **xv6-riscv kernel used in this course**. Although the actual porting implementation is beyond the scope of this project, it is valuable as a thought experiment for verifying the generality of the system.

## 1. Why Porting Is Needed, and Its Limits

xv6-riscv does not include a network stack or TLS library, so **calling the Solar API directly inside xv6 is impossible**. Therefore, the porting design is split into two parts:

- **xv6 kernel side**: Memory pressure detection, candidate collection, victim signaling.
- **Host side (outside QEMU)**: A Python helper responsible for LLM API calls.
- **Communication between the two**: QEMU's virtual serial port (`uart.c`) is used as the channel.

This directly inherits the "C daemon ↔ Python helper" separation from the Linux implementation.

## 2. Memory Pressure Detection — Hook in `kalloc.c`

xv6 has no equivalent of PSI, so we substitute it by inspecting the free-page count **at the moment `kalloc()` is called**.

The following logic is added to `kernel/kalloc.c`.

```c
// add to kalloc.c
static int free_pages_count = 0;     // current number of free pages
static int oom_threshold = 64;       // threshold (in pages)
extern void notify_oom_pressure(void); // new function

void *
kalloc(void)
{
  // ... existing allocation logic ...

  if (free_pages_count < oom_threshold) {
    notify_oom_pressure();  // notify the host helper
  }
  return ptr;
}
```

`free_pages_count` is maintained by counting the freelist length.

## 3. New System Calls — Link to the User-Space Helper

Following the system-call addition pattern covered in class, two new system calls are introduced.

| System Call | Role |
|-------------|------|
| `sys_get_oom_candidates(buf, max)` | Traverse the proc table and return candidate metadata |
| `sys_kill_victim(pid)` | Send a signal to a verified PID (using `kill()` in `proc.c`) |

Insertion points follow the pattern taught in class:

- `kernel/syscall.h` — Register `SYS_get_oom_candidates`, `SYS_kill_victim` numbers
- `kernel/syscall.c` — Add function pointers to the `syscalls[]` array
- `kernel/sysproc.c` — Actual implementations (`sys_get_oom_candidates`, `sys_kill_victim`)
- `user/user.h` — Declare user-space prototypes
- `user/usys.pl` — User-to-kernel trap entry points

## 4. Host Communication — UART Channel

QEMU can connect xv6's virtual serial port to the host's stdio. Using this, we construct the following communication structure.

```
[xv6 kernel]                                [Host (outside QEMU)]
│                                            │
│  candidates JSON via UART  ───────►       │
│  (uses uartputc in kernel/uart.c)          │
│                                       Python LLM Helper
│                                       (calls Solar API)
│                                            │
│  ◄───── decision JSON via UART            │
│       (uses uartgetc in kernel/uart.c)     │
▼
sys_kill_victim(pid) invocation
```

Pseudo-code on the xv6 kernel side:

```c
void notify_oom_pressure(void) {
    char buf[CAND_BUF_SIZE];
    int n = collect_candidates(buf, sizeof(buf));
    uart_write(buf, n);                       // send candidates
    sleep(&uart_response_channel, &lock);     // wait for response
    int victim_pid = parse_decision(uart_buf);
    kill(victim_pid);                          // reuse existing function in proc.c
}
```

## 5. Response Waiting Mechanism — `sleep` / `wakeup`

An LLM call takes 1–2 seconds. In the Linux implementation, blocking `read` on a pipe handles this naturally; in xv6, we must use the explicit `sleep()` / `wakeup()` pattern.

- Waiting for the UART response is done by `sleep(&channel, &lock)`.
- The UART interrupt handler (`uartintr`) calls `wakeup(&channel)` upon arrival of the response.
- This is the same pattern already used for disk I/O in xv6.

## 6. xv6 / OS Concepts Used by This Design

| Concept | Location in xv6 | Use in This Design |
|---------|------------------|---------------------|
| Physical memory management | `kalloc.c` | Trigger point for OOM |
| Process table | `proc.c` | Source of candidate collection |
| System call addition | `syscall.c`, `sysproc.c` | Interface with the user-space helper |
| Device driver | `uart.c` | Communication channel with the host |
| `sleep`/`wakeup` | `proc.c` | Asynchronous response waiting |
| Signals / process termination | `kill()` in `proc.c` | Victim termination |

## 7. Mini-Prototype Possibility (Bonus, Week 13)

If time permits in Week 13, the following mini-prototype can be demonstrated:

- Add a single echo system call to xv6 (`sys_echo_to_host`).
- Round-trip communication with a host-side Python script over UART.
- Demonstrate that the communication structure of this design actually works.

The full port is out of scope, but this mini-prototype is the key piece for validating the design's feasibility.

## 8. Limitations of the Design

- xv6 lacks fine-grained page-level statistics, so the threshold is judged solely by the free-page count.
- UART is intrinsically a slow channel, with serialization/deserialization overhead.
- Plain-text communication is security-vulnerable (unsuitable for a real system; demonstrative purposes only).
- xv6 is a single-user OS, so the notion of "per-user policy" is weak.

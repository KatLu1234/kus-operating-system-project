#ifndef VALIDATOR_H
#define VALIDATOR_H

#include <stdbool.h>
#include <sys/types.h>

// 이 PID를 죽여도 괜찮은지 안전 검사를 선언합니다.
bool validator_ok(pid_t pid);

#endif /* VALIDATOR_H */
#include "validator.h"
#include <stdio.h>
#include <unistd.h>
#include <string.h>

// 절대로 AI가 건드리면 안 되는 리눅스의 생명줄 프로세스 이름들입니다.
static const char *PROTECTED_NAMES[] = {
    "systemd",
    "sshd",
    "dbus-daemon",
    "init",
    "coomd", // 데몬 자신도 보호 대상
    NULL
};

bool validator_ok(pid_t pid) {
    // 1. 컴퓨터의 심장인 PID 1 (init) 프로세스는 무조건 통과시킵니다.
    if (pid <= 1) {
        return false;
    }

    // 2. 관리자 본인(coomd)이 자살하는 어처구니없는 참사를 방지합니다.
    if (pid == getpid()) {
        return false;
    }

    char comm[16] = {0};
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/comm", pid);
    
    FILE *f = fopen(path, "r");
    if (!f) {
        // 이미 프로세스가 스스로 꺼진 상태라면 안 죽여도 되니 패스합니다.
        return true; 
    }
    
    // 프로세스의 실제 이름을 읽어와서 화이트리스트와 비교합니다.
    if (fscanf(f, "%15s", comm) == 1) {
        for (int i = 0; PROTECTED_NAMES[i] != NULL; i++) {
            if (strcmp(comm, PROTECTED_NAMES[i]) == 0) {
                fclose(f);
                return false; // 여기에 등록된 이름이면 절대 죽이지 못하게 막습니다!
            }
        }
    }
    
    fclose(f);
    return true; 
}
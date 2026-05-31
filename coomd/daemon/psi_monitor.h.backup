#ifndef PSI_MONITOR_H
#define PSI_MONITOR_H

#include <stdbool.h>

// R1의 이벤트 데이터 박스 양식입니다.
typedef struct {
    double some_avg10;
    double some_avg60;
    double full_avg10;
    long timestamp;
} psi_event_t;

// 일부러 메모리 부족 상태(16.5%)를 반환하는 가짜 경고등
static inline bool r1_check_pressure(double threshold, psi_event_t *event) {
    event->some_avg10 = 16.5; 
    event->some_avg60 = 8.2;
    event->full_avg10 = 0.5;
    event->timestamp = 1680000000;

    // 만약 연료가 경고치(threshold)를 넘었으면 true를 반환해서 R1이 경고등을 켜도록 합니다.
    if (event->some_avg10 > threshold) {
        return true;
    }
    return false;
}

#endif /* PSI_MONITOR_H */
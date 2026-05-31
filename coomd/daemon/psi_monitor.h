#ifndef PSI_MONITOR_H
#define PSI_MONITOR_H

#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

// R1의 이벤트 데이터 박스 양식입니다.
typedef struct {
    double some_avg10;
    double some_avg60;
    double full_avg10;
    long timestamp;
} psi_event_t;

// ──────────────────────────────────────────────────────────
// 실제 /proc/pressure/memory를 읽어서 메모리 압박 상태를 확인한다.
//   파일 형식:
//     some avg10=0.00 avg60=0.00 avg300=0.00 total=0
//     full avg10=0.00 avg60=0.00 avg300=0.00 total=0
//
//   - some_avg10이 threshold(%)를 넘으면 true 반환 → 트리거 발동
//   - 파일을 못 읽으면 false (안전한 기본값)
// ──────────────────────────────────────────────────────────
static inline bool r1_check_pressure(double threshold, psi_event_t *event) {
    // 안전한 기본값으로 초기화
    event->some_avg10 = 0.0;
    event->some_avg60 = 0.0;
    event->full_avg10 = 0.0;
    event->timestamp = (long)time(NULL);

    FILE *f = fopen("/proc/pressure/memory", "r");
    if (!f) {
        // PSI 미지원 시스템: 압박 없음으로 처리 (안전)
        return false;
    }

    char line[256];
    while (fgets(line, sizeof(line), f)) {
        // "some" 줄 파싱
        if (strncmp(line, "some", 4) == 0) {
            sscanf(line, "some avg10=%lf avg60=%lf",
                   &event->some_avg10, &event->some_avg60);
        }
        // "full" 줄 파싱
        else if (strncmp(line, "full", 4) == 0) {
            sscanf(line, "full avg10=%lf",
                   &event->full_avg10);
        }
    }
    fclose(f);

    // some_avg10이 임계값을 넘으면 트리거 발동
    return (event->some_avg10 > threshold);
}

#endif /* PSI_MONITOR_H */

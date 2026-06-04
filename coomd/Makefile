CC = gcc
CFLAGS = -Wall -Wextra -O2 -g
TARGET = bin/coomd
SRCS = daemon/main.c daemon/xv6_state.c daemon/validator.c
OBJS = $(SRCS:.c=.o)

all: $(TARGET)

$(TARGET): $(OBJS)
	@mkdir -p bin
	$(CC) $(CFLAGS) -o $(TARGET) $(OBJS)

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -rf daemon/*.o bin/

.PHONY: all clean

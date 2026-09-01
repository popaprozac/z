package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"time"
)

func iterations() uint64 {
	value, error := strconv.ParseUint(os.Getenv("Z_BENCH_ITERATIONS"), 10, 64)
	if error != nil || value == 0 {
		panic("invalid Z_BENCH_ITERATIONS")
	}
	return value
}

func main() {
	count := iterations()
	channel := make(chan uint64, 1)
	result := make(chan uint64, 1)
	go func() {
		runtime.LockOSThread()
		var checksum uint64
		for received := uint64(0); received < count; received++ {
			checksum += <-channel
		}
		result <- checksum
	}()

	started := time.Now()
	for value := uint64(0); value < count; value++ {
		channel <- value
	}
	checksum := <-result
	fmt.Printf("RESULT channel-thread %d %d\n", time.Since(started).Nanoseconds(), checksum)
}

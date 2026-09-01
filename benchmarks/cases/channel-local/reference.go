package main

import (
	"fmt"
	"os"
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
	var index uint64
	var checksum uint64
	started := time.Now()
	for index < count {
		channel <- index
		checksum += <-channel
		index++
	}
	fmt.Printf("RESULT channel-local %d %d\n", time.Since(started).Nanoseconds(), checksum)
}

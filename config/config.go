package config

import (
	"os"
	"strconv"
	"time"
)

// GetString returns a setting in string.
func GetString(key string) string {
	val, exists := os.LookupEnv(key)
	if !exists {
		panic(key)
	}

	return val
}

// GetBool returns a setting in bool.
func GetBool(key string) bool {
	var val bool
	var err error
	if val, err = strconv.ParseBool(GetString(key)); err != nil {
		panic(err)
	}

	return val
}

// GetInt returns a setting in integer.
func GetInt(key string) int {
	val := int(GetInt64(key))
	return val
}

// GetUint returns a setting in unsigned integer.
func GetUint(key string) uint {
	val := uint(GetUint64(key))
	return val
}

// GetInt64 returns a setting in 64-bit signed integer.
func GetInt64(key string) int64 {
	// Parse int64 value from environment variable.
	var val int64
	var err error
	if val, err = strconv.ParseInt(GetString(key), 0, 64); err != nil {
		panic(err)
	}

	return val
}

// GetUint64 returns a setting in 64-bit unsigned integer.
func GetUint64(key string) uint64 {
	// Parse uint64 value from environment variable.
	var val uint64
	var err error
	if val, err = strconv.ParseUint(GetString(key), 0, 64); err != nil {
		panic(err)
	}

	return val
}

// GetMilliseconds returns a setting in time.Duration.
func GetMilliseconds(key string) time.Duration {
	val := time.Duration(GetUint(key)) * time.Millisecond
	return val
}

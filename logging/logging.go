package logging

import (
	"fmt"
	"os"
	"path"
	"runtime"
	"time"

	"github.com/jswirl/miit/config"
	"github.com/jswirl/miit/global"
)

// Logger is our logger instance abstraction.
type Logger struct {
	RequestID string
}

// Singleton logger instance.
var staticLogger = &Logger{global.ServiceName}

// Static configuration variables initalized at runtime.
var logLevel uint

// Log levels.
const (
	logLevelFirst = iota
	logLevelCritical
	logLevelError
	logLevelWarn
	logLevelInfo
	logLevelDebug
	logLevelLast
)

// Log level to label string.
var logLabels = []string{
	"",
	"\x1b[0;37;41m  CRIT \x1b[m",
	"\x1b[0;30;41m ERROR \x1b[m",
	"\x1b[0;30;43m  WARN \x1b[m",
	"\x1b[0;30;47m  INFO \x1b[m",
	"\x1b[0;30;42m DEBUG \x1b[m",
	"",
}

// init loads the logging configurations.
func init() {
	logLevel = config.GetUint("LOG_LEVEL")
}

// NewLogger returns a new copy of a logger instance.
func NewLogger(requestID string) (*Logger, error) {
	// Create and return new logger instance.
	return &Logger{requestID}, nil
}

// Critical logs a message of critical severity using the static logger..
func Critical(format string, args ...interface{}) {
	logWithLineNumber(staticLogger, logLevelCritical, format, args...)
}

// Critical logs a message of critical severity.
func (logger *Logger) Critical(format string, args ...interface{}) {
	logWithLineNumber(logger, logLevelCritical, format, args...)
}

// Error logs a message of error severity using the static logger.
func Error(format string, args ...interface{}) {
	logWithLineNumber(staticLogger, logLevelError, format, args...)
}

// Error logs a message of error severity.
func (logger *Logger) Error(format string, args ...interface{}) {
	logWithLineNumber(logger, logLevelError, format, args...)
}

// Warn logs a message of warning severity using the static logger.
func Warn(format string, args ...interface{}) {
	log(staticLogger, logLevelWarn, format, args...)
}

// Warn logs a message of warning severity.
func (logger *Logger) Warn(format string, args ...interface{}) {
	log(logger, logLevelWarn, format, args...)
}

// Info logs a message of informational severity using the static logger.
func Info(format string, args ...interface{}) {
	log(staticLogger, logLevelInfo, format, args...)
}

// Info logs a message of informational severity.
func (logger *Logger) Info(format string, args ...interface{}) {
	log(logger, logLevelInfo, format, args...)
}

// Debug logs a message of debugging severity using the static logger.
func Debug(format string, args ...interface{}) {
	log(staticLogger, logLevelDebug, format, args...)
}

// Debug logs a message of debugging severity.
func (logger *Logger) Debug(format string, args ...interface{}) {
	log(logger, logLevelDebug, format, args...)
}

// log is the general logging utility function used by all log levels.
func log(logger *Logger, level uint, format string, args ...interface{}) {
	// Perform logging only if configured above and within valid log level.
	if level <= logLevelFirst || level >= logLevelLast || level > logLevel {
		return
	}

	// Compose log message.
	message := fmt.Sprintf(format, args...)

	// now is the current Unix timestamp in floating point.
	now := float64(time.Now().UnixNano()) / float64(time.Second)

	// Reset terminal color.
	fmt.Print("\x1b[m")

	// Log to standard output.
	fmt.Fprintf(os.Stdout,
		"\r\x1b[100m%f\x1b[m %s\x1b[m \x1b[100m%12s\x1b[m %s\n",
		now, logLabels[level], logger.RequestID, message)
}

// logWithLineNumber performs usual logging but with an extra line number arg.
func logWithLineNumber(logger *Logger, level uint, format string,
	args ...interface{}) {
	// Get caller file name and line number.
	_, filepath, line, ok := runtime.Caller(2)
	if ok {
		filename := path.Base(filepath)
		format = fmt.Sprintf("%s (%s:%d)", format, filename, line)
	}
	log(logger, level, format, args...)
}

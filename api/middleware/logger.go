package middleware

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/jswirl/miit/logging"
)

// ignoredPrefixes is a list of URL prefixes that we should ignore from logging.
var ignoredPrefixes = map[string]string{
	"/alive":          http.MethodGet,
	"/ready":          http.MethodGet,
	"/system/time":    http.MethodGet,
	"/system/version": http.MethodGet,
	"/miitings":       http.MethodPatch,
}

// Logger returns a request logger middleware, which logs the HTTP request and
// creates a logger instance to be used throughout the execution of the request.
func Logger() gin.HandlerFunc {
	return func(ctx *gin.Context) {
		// Generate request ID and create new logger.
		requestID := generateRequestID(ctx.Request)
		logger, err := logging.NewLogger(requestID)
		if err != nil {
			logging.Error("Failed to create new logger: %v", err)
			ctx.Abort()
			return
		}

		// Inject the request logger into Gin context.
		ctx.Set("logger", logger)

		// Do nothing if the request URL is on the blacklist.
		url := ctx.Request.URL.EscapedPath()
		urlPrefix := getURLPrefix(url)
		urlMethod, exists := ignoredPrefixes[urlPrefix]
		if exists && urlMethod == ctx.Request.Method {
			return
		}

		// Collect relevant information from this request to be logged.
		address := ctx.ClientIP()
		method := ctx.Request.Method
		params := ctx.Request.URL.RawQuery
		headersMap, err := json.Marshal(ctx.Request.Header)
		if err != nil {
			logger.Error("Failed to marshal headers: %v", err)
			headersMap = []byte{}
		}
		headers := string(headersMap)

		// Log the incoming request information.
		logger.Info("Client: [%15s], Method: [%6s], Path: [%s], Params: [%s],"+
			" Headers: %s", address, method, url, params, headers)

		// Continue processing request chain while measuring response time.
		start := time.Now()
		ctx.Next()
		elapsed := time.Since(start)

		// Get response code.
		code := ctx.Writer.Status()

		// Log the request body on error.
		var body string
		if (method == http.MethodPost || method == http.MethodPatch) &&
			code >= http.StatusBadRequest {
			body = string(GetBody(ctx))
		}

		// Log the outgoing response information.
		if code >= 400 {
			logger.Error("Code: [%3d], Latency: [%10v], Body: [%s]",
				code, elapsed, body)
		} else {
			logger.Info("Code: [%3d], Latency: [%10v], Body: [%s]",
				code, elapsed, body)
		}

	}
}

// GetLogger returns the request logger from the Gin context if it's present.
func GetLogger(ctx *gin.Context) *logging.Logger {
	// Lookup the request logger.
	value, exists := ctx.Get("logger")
	if !exists {
		logging.Error("Failed to lookup request logger")
		return nil
	}

	// Convert the interface to request logger.
	logger, ok := value.(*logging.Logger)
	if !ok {
		logging.Error("Failed to convert to request logger")
		return nil
	}

	return logger
}

// getURLPrefix extracts the first path component of the request URL.
func getURLPrefix(url string) string {
	// Find the second '/' in the URL.
	for idx, character := range url {
		if character == '/' && idx > 0 {
			return string(url[:idx])
		}
	}

	// Return original URL string if we reach the end of the string.
	return url
}

// generateRequestID generates a request ID for all logs of this request.
func generateRequestID(request *http.Request) string {
	// Generate hash object.
	hash := fnv.New64a()

	// Use time as hash component.
	currentTimeBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(currentTimeBytes,
		uint64(time.Now().UnixNano()))

	// Compute hash value.
	hash.Write([]byte(request.Host))
	hash.Write([]byte(request.RemoteAddr))
	hash.Write([]byte(request.RequestURI))
	hash.Write(currentTimeBytes)

	return fmt.Sprintf("%012x", hash.Sum64())[:12]
}

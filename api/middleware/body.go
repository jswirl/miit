package middleware

import (
	"bytes"
	"io/ioutil"

	"github.com/gin-gonic/gin"
	"github.com/jswirl/miit/logging"
)

// Body reads and partially copies the request body for debugging.
func Body(size int64) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		// Only copy the request body if it's <= than the specified length.
		if ctx.Request.ContentLength > 0 &&
			ctx.Request.ContentLength <= size &&
			ctx.Request.Body != nil {
			// Read request body.
			body := readRequestBody(ctx, size)

			// Inject copied request body into Gin context.
			ctx.Set("body", body)
		}

		// Continue processing request handler chain.
		ctx.Next()
	}
}

// GetBody returns a copy of the request body if it's present.
func GetBody(ctx *gin.Context) []byte {
	// Lookup the copied request body.
	value, exists := ctx.Get("body")
	if !exists {
		return nil
	}

	// Convert the body to byte slice.
	body, ok := value.([]byte)
	if !ok {
		return nil
	}

	return body
}

// readRequestBody reads and returns part of the request body as byte slice.
func readRequestBody(ctx *gin.Context, size int64) []byte {
	// Obtain logger handle.
	logger := GetLogger(ctx)
	if logger == nil {
		logging.Error("Failed to obtain request logger")
		return nil
	}

	// Read the request body into byte slice.
	body, err := ioutil.ReadAll(ctx.Request.Body)
	if err != nil {
		logger.Error("Failed to read request body: %v", err)
		return nil
	}

	// Close the body after reading.
	if err := ctx.Request.Body.Close(); err != nil {
		logger.Error("Failed to close request body: %v", err)
		return nil
	}

	// Create a new slice and copy the first size bytes of the body.
	bodyCopy := make([]byte, size)
	copy(bodyCopy, body)

	// Restore the read contents back to body.
	ctx.Request.Body = ioutil.NopCloser(bytes.NewBuffer(body))

	return bodyCopy
}

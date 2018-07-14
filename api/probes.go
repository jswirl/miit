package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/jswirl/miit/global"
)

func init() {
	// Obtain the root router group.
	root := GetRoot()

	// Register the liveness/readiness probe handlers.
	root.GET("alive", Alive)
	root.GET("ready", Ready)

}

// Alive is the handler for Kubernetes liveness probes.
func Alive(ctx *gin.Context) {
	// Set status code based on liveness indication flag.
	statusCode := http.StatusServiceUnavailable
	if global.Alive {
		statusCode = http.StatusOK
	}

	// Respond to probe according to current liveness status.
	ctx.JSON(statusCode, gin.H{
		"alive": global.Alive,
	})
}

// Ready is the handler for Kubernetes readiness probes.
func Ready(ctx *gin.Context) {
	// Set status code based on readiness indication flag.
	statusCode := http.StatusServiceUnavailable
	if global.Ready {
		statusCode = http.StatusOK
	}

	// Respond to probe according to current readiness status.
	ctx.JSON(statusCode, gin.H{
		"ready": global.Ready,
	})
}

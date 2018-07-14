package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/jswirl/miit/global"
)

func init() {
	// Obtain the root router group.
	root := GetRoot()

	// Create router group for system module.
	systemGroup := root.Group("system")

	// Register the system module handlers.
	systemGroup.GET("version", Version)
	systemGroup.GET("time", Time)

}

// Version is the handler for responding system version requests.
func Version(ctx *gin.Context) {
	// Respond with the commit hash of this code and its build time.
	ctx.JSON(http.StatusOK, gin.H{
		"service": global.ServiceName,
		"commit":  global.GitCommitHash,
		"time":    global.BuildTime,
	})
}

// Time is the handler for responding the current system time.
func Time(ctx *gin.Context) {
	// Respond with the current system timestamp in milliseconds.
	timestamp := time.Now().UnixNano() / 10e6
	ctx.JSON(http.StatusOK, gin.H{
		"time": timestamp,
	})
}

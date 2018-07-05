package main

import (
	"fmt"

	"github.com/jswirl/miit/config"
	"github.com/jswirl/miit/global"
	"github.com/jswirl/miit/logging"
	"github.com/jswirl/miit/server"
)

func main() {
	// Cancel global root context on return.
	defer global.Cancel()

	// We're running, turn on the liveness indication flag.
	global.Alive = true

	// Create HTTP server instance.
	address := fmt.Sprintf("%s:%s",
		config.GetString("SERVER_LISTEN_ADDRESS"),
		config.GetString("SERVER_LISTEN_PORT"))
	server := server.CreateServer(global.Context, address)

	// Now that we finished initializing all necessary modules,
	// let's turn on the readiness indication flag.
	global.Ready = true

	// Start servicing requests.
	logging.Info("Initialization complete, listening on %s...", address)
	if err := server.ListenAndServe(); err != nil {
		logging.Info(err.Error())
	}
}

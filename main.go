package main

import (
	"context"
	"fmt"

	"github.com/jswirl/miit/config"
	"github.com/jswirl/miit/global"
	"github.com/jswirl/miit/logging"
	"github.com/jswirl/miit/server"
)

func main() {
	// We're running, turn on the liveness indication flag.
	global.Alive = true

	// Create root context.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Create HTTP server instance.
	address := fmt.Sprintf("%s:%s",
		config.GetString("SERVER_LISTEN_ADDRESS"),
		config.GetString("SERVER_LISTEN_PORT"))
	server := server.CreateServer(ctx, address)

	// Now that we finished initializing all necessary modules,
	// let's turn on the readiness indication flag.
	global.Ready = true

	// Start servicing requests.
	logging.Info("Initialization complete, listening on %s...", address)
	if err := server.ListenAndServe(); err != nil {
		logging.Info(err.Error())
	}
}

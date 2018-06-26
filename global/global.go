package global

// Status flags for Kubernetes probes. Ideally, these should be protected by
// mutexes, but since we will most likely access these variables from only a
// few places, lets spare the trouble.
var (
	// Ready indicates whether the microservice is ready to serve requests.
	Ready = false

	// Alive indicates whether the microservice is up and running and currently
	// not in the process of shutting down.
	Alive = false
)

// ServiceName is the global name of this microservice. The string is also used
// as the URL path prefix in the global root router group. The value of this
// string is configured using the ldflags compile option.
var ServiceName string

// GitCommitHash is the Git revision of the built binary. The value of this
// string is set automatically by the build script.
var GitCommitHash string

// BuildTime is the time at which this binary was built. The value of this
// string is set automatically by the build script.
var BuildTime string

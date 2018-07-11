PROJECT_ID=miit
SERVICE_NAME=$(shell basename `git rev-parse --show-toplevel`)
IMPORT_PATH=github.com/jswirl/${SERVICE_NAME}
GIT_COMMIT_HASH=$(shell git rev-parse HEAD | cut -c -16)
BUILD_TIME=$(shell date +%s)
LDFLAGS = -X ${IMPORT_PATH}/global.ServiceName=${SERVICE_NAME}
LDFLAGS += -X ${IMPORT_PATH}/global.GitCommitHash=${GIT_COMMIT_HASH}
LDFLAGS += -X ${IMPORT_PATH}/global.BuildTime=${BUILD_TIME}
LDFLAGS += -s -w

.PHONY: all clean

all: ${SERVICE_NAME}

${SERVICE_NAME}: clean
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ./${SERVICE_NAME} -ldflags "$(LDFLAGS)" ./main.go

clean:
	rm -f ./${SERVICE_NAME}

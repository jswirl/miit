package api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jswirl/miit/api/middleware"
	"github.com/jswirl/miit/config"
)

// miiting is the object representing a miiting.
type miiting struct {
	Initiator  string                   `json:"initiator"`
	Timestamp  time.Time                `json:"timestamp"`
	offer      *sessionDescription      `json:"-"`
	answer     *sessionDescription      `json:"_"`
	offerChan  chan *sessionDescription `json:"-"`
	answerChan chan *sessionDescription `json:"-"`
}

// sessionDescription is the model of a offer/answer session description.
type sessionDescription struct {
	Name          string           `json:"name"`
	Type          string           `json:"type"`
	Description   *json.RawMessage `json:"description"`
	IceCandidates *json.RawMessage `json:"ice_candidates"`
}

// miitings contains all current
var miitings sync.Map

// miit main HTML index page and main JavaScript file path.
var miitAssetsPath string
var indexPagePath string
var scriptPath string

func init() {
	// Load asset configuration paths.
	miitAssetsPath = config.GetString("MIIT_ASSETS_PATH")
	indexPagePath = config.GetString("MIIT_INDEX_PAGE_PATH")
	scriptPath = config.GetString("MIIT_JAVASCRIPT_PATH")

	// Obtain the root router group.
	root := GetRoot()

	// Create router group for miit assets.
	// TODO: remove this when HTTP/2 server push is available.
	miitGroup := root.Group("miit")
	miitGroup.Static("/", miitAssetsPath)

	// Create router group for miiting module and register handlers.
	miitingsGroup := root.Group("miitings")
	miitingsGroup.Use(middleware.Body(1024))
	miitingsGroup.GET(":miiting_id", GetMiiting)
	miitingsGroup.POST(":miiting_id", CreateMiiting)
	miitingsGroup.DELETE(":miiting_id", AdjournMiiting)
	miitingsGroup.GET(":miiting_id/:sdp_type", GetSDP)
	miitingsGroup.POST(":miiting_id/:sdp_type", SetSDP)
}

// GetMiiting returns the main index page for requests.
func GetMiiting(ctx *gin.Context) {
	// We return the main index page no matter the requested resource.
	ctx.File(indexPagePath)
}

// PushMiitAssets is the handler for pushing the miit assets to clients.
func PushMiitAssets(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Get the miiting ID from path params.
	miitingID := ctx.Param("miiting_id")
	if len(miitingID) <= 0 {
		logger.Error("Invalid miiting ID: [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Get the server push instance from context.
	pusher := ctx.Writer.Pusher()
	if pusher == nil {
		logger.Error("Failed to get HTTP/2 server push instance")
		ctx.AbortWithStatus(http.StatusInternalServerError)
		return
	}

	// Push miit assets to client.
	assets := []string{indexPagePath, scriptPath}
	for _, asset := range assets {
		if err := pusher.Push(asset, nil); err != nil {
			logger.Error("Failed to push asset [%s]: %v", asset, err)
			ctx.AbortWithStatus(http.StatusInternalServerError)
			return
		}
	}

	// We've done pushing, finish with empty JSON response.
	ctx.JSON(http.StatusOK, gin.H{})
}

// CreateMiiting is the handler for requests creating a miiting.
func CreateMiiting(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Get the miiting ID from path params.
	miitingID := ctx.Param("miiting_id")
	if len(miitingID) <= 0 {
		logger.Error("Invalid miiting ID: [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Get miiting initiator name from request body.
	body := map[string]string{}
	if err := ctx.BindJSON(&body); err != nil {
		logger.Error("Failed to unmarshal miiting creation request: %v", err)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Create and prepare the new miiting.
	value := miiting{
		Initiator:  body["initiator"],
		Timestamp:  time.Now(),
		offer:      nil,
		answer:     nil,
		offerChan:  nil,
		answerChan: nil,
	}

	// Check and create the miiting if it doesn't exist.
	if _, exists := miitings.LoadOrStore(miitingID, &value); exists {
		ctx.JSON(http.StatusOK, &value)
	} else {
		ctx.JSON(http.StatusCreated, &value)
	}
}

// AdjournMiiting is the handler for requests deleting a miiting.
func AdjournMiiting(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Get the miiting ID from path params.
	miitingID := ctx.Param("miiting_id")
	if len(miitingID) <= 0 {
		logger.Error("Invalid miiting ID: [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Delete the miiting from miitings map.
	miitings.Delete(miitingID)

	// Respond with empty JSON.
	ctx.JSON(http.StatusOK, gin.H{})
}

// GetSDP is the handler for requests getting a session description for a role.
func GetSDP(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Get the requested miiting ID from path params.
	miitingID := ctx.Param("miiting_id")
	if len(miitingID) <= 0 {
		logger.Error("Invalid miiting ID: [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Get the requested SDP type from path params.
	sdpType := ctx.Param("sdp_type")
	if len(sdpType) <= 0 {
		logger.Error("Invalid sdp_type: [%s]", sdpType)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Lookup the requested miiting.
	value, exists := miitings.Load(miitingID)
	if !exists {
		logger.Error("Failed to find miiting [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}
	miiting := value.(*miiting)

	// Get the requested SDP from our miiting.
	var sdp *sessionDescription
	var sdpChan chan *sessionDescription
	if sdpType == "offer" {
		if sdp = miiting.offer; sdp == nil {
			miiting.offerChan = make(chan *sessionDescription)
			sdpChan = miiting.offerChan
		}
	} else if sdpType == "answer" {
		if sdp = miiting.answer; sdp == nil {
			miiting.answerChan = make(chan *sessionDescription)
			sdpChan = miiting.answerChan
		}
	} else {
		logger.Error("Invalid sdp_type: [%s]", sdpType)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Wait for the description if it has not been submitted yet.
	if sdp == nil {
		sdp = <-sdpChan
	}

	// Return the requested SDP.
	ctx.JSON(http.StatusOK, sdp)
}

// SetSDP is the handler for requests setting a session description for a role.
func SetSDP(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Get the requested miiting ID from path params.
	miitingID := ctx.Param("miiting_id")
	if len(miitingID) <= 0 {
		logger.Error("Invalid miiting ID: [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Get the requested SDP type from path params.
	sdpType := ctx.Param("sdp_type")
	if len(sdpType) <= 0 {
		logger.Error("Invalid sdp_type: %s", sdpType)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Extract the SDP from request body.
	sdp := sessionDescription{}
	if err := ctx.BindJSON(&sdp); err != nil {
		logger.Error("Failed to extract SDP from request body: %v", err)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Lookup the requested miiting.
	value, exists := miitings.Load(miitingID)
	if !exists {
		logger.Error("Failed to find miiting [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}
	miiting := value.(*miiting)

	// Get the requested SDP from our miiting.
	if sdpType == "offer" {
		// Write the submitted offer to the offer channel if one is waiting.
		miiting.offer = &sdp
		if miiting.offerChan != nil {
			miiting.offerChan <- &sdp
		}
	} else if sdpType == "answer" {
		// Write the submitted answer to the answer channel if one is waiting.
		miiting.answer = &sdp
		if miiting.answerChan != nil {
			miiting.answerChan <- &sdp
		}
	} else {
		logger.Error("Invalid sdp_type: %s", sdpType)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Respond with empty JSON.
	ctx.JSON(http.StatusOK, gin.H{})
}

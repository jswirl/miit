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
	token      string                   `json:"-"`
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
	IceCandidates []*iceCandidate  `json:"ice_candidates"`
}

// iceCandidate is the struct representing an ICE candidate of a peer.
type iceCandidate struct {
	Candidate     string `json:"candidate"`
	SdpMid        string `json:"sdpMid"`
	SdpMLineIndex uint   `json:"sdpMLineIndex"`
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
	miitingsGroup.GET(":miiting", GetMiiting)
	miitingsGroup.POST(":miiting", CreateMiiting)
	miitingsGroup.DELETE(":miiting", AdjournMiiting)
	miitingsGroup.GET(":miiting/:type", GetSDPAndICECandidates)
	miitingsGroup.POST(":miiting/:type", SetSDPAndICECandidates)
	miitingsGroup.PUT(":miiting/:type", SetSDPAndICECandidates)
	// TODO: use PATH and do partial updates instead.
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
	miitingID := ctx.Param("miiting")
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
	miitingID := ctx.Param("miiting")
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
		token:      body["token"],
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
	miitingID := ctx.Param("miiting")
	if len(miitingID) <= 0 {
		logger.Error("Invalid miiting ID: [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Get the token associated with the creating of this miiting.
	token := ctx.Query("token")

	// Lookup the requested miiting.
	value, exists := miitings.Load(miitingID)
	if !exists {
		logger.Error("Failed to find miiting [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusNotFound)
		return
	}
	miiting := value.(*miiting)

	// Delete the miiting from miitings map.if token matches.
	if miiting.token != token {
		ctx.AbortWithStatus(http.StatusUnauthorized)
	} else {
		miitings.Delete(miitingID)
		ctx.JSON(http.StatusOK, gin.H{})
	}
}

// GetSDPAndICECandidates is the handler for getting SDP and ICE candidates.
func GetSDPAndICECandidates(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Get the requested miiting ID from path params.
	miitingID := ctx.Param("miiting")
	if len(miitingID) <= 0 {
		logger.Error("Invalid miiting ID: [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Get the requested SDP type from path params.
	sdpType := ctx.Param("type")
	if len(sdpType) <= 0 {
		logger.Error("Invalid SDP type: [%s]", sdpType)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Check whether we should only return ICE candidates.
	var iceCandidatesOnly bool
	iceParam := ctx.DefaultQuery("ice_only", "false")
	switch iceParam {
	case "1", "true", "yes":
		iceCandidatesOnly = true
	case "0", "false", "no", "":
		fallthrough
	default:
		iceCandidatesOnly = false
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
		if sdp = miiting.offer; sdp == nil || len(sdp.IceCandidates) == 0 {
			miiting.offerChan = make(chan *sessionDescription, 1)
			sdpChan = miiting.offerChan
		}
	} else if sdpType == "answer" {
		if sdp = miiting.answer; sdp == nil || len(sdp.IceCandidates) == 0 {
			miiting.answerChan = make(chan *sessionDescription, 1)
			sdpChan = miiting.answerChan
		}
	} else {
		logger.Error("Invalid SDP type: [%s]", sdpType)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Wait for the description if it has not been submitted yet.
	if sdp == nil || (iceCandidatesOnly && len(sdp.IceCandidates) == 0) {
		sdp = <-sdpChan
	}

	// Return the requested SDP and/or ICE candidates.
	if iceCandidatesOnly {
		ctx.JSON(http.StatusOK, sdp.IceCandidates)
	} else {
		ctx.JSON(http.StatusOK, sdp)
	}
}

// SetSDPAndICECandidates is the handler for setting SDP and ICE candidates.
func SetSDPAndICECandidates(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Get the requested miiting ID from path params.
	miitingID := ctx.Param("miiting")
	if len(miitingID) <= 0 {
		logger.Error("Invalid miiting ID: [%s]", miitingID)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Get the requested SDP type from path params.
	sdpType := ctx.Param("type")
	if len(sdpType) <= 0 {
		logger.Error("Invalid SDP type: %s", sdpType)
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
		// Make sure the offer is not created twice.
		if miiting.offer != nil && ctx.Request.Method == http.MethodPost {
			logger.Error("Multiple POSTs to [%s/offer]", miitingID)
			ctx.AbortWithStatus(http.StatusForbidden)
			return
		}

		// Write the submitted offer to the offer channel if one is waiting.
		miiting.offer = &sdp
		if miiting.offerChan != nil {
			miiting.offerChan <- &sdp
		}
	} else if sdpType == "answer" {
		// Make sure the offer is not created twice.
		if miiting.answer != nil && ctx.Request.Method == http.MethodPost {
			logger.Error("Multiple POSTs to [%s/answer]", miitingID)
			ctx.AbortWithStatus(http.StatusForbidden)
			return
		}

		// Write the submitted answer to the answer channel if one is waiting.
		miiting.answer = &sdp
		if miiting.answerChan != nil {
			miiting.answerChan <- &sdp
		}
	} else {
		logger.Error("Invalid SDP type: %s", sdpType)
		ctx.AbortWithStatus(http.StatusBadRequest)
		return
	}

	// Respond with empty JSON.
	ctx.JSON(http.StatusOK, gin.H{})
}

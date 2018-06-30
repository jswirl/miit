package api

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jswirl/miit/api/middleware"
	"github.com/jswirl/miit/config"
)

// miiting is the object representing a miiting.
type miiting struct {
	timestamp  time.Time                `json:"timestamp"`
	tokens     []string                 `json:"-"`
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

// miitings contains all current miitings.
var miitings sync.Map

// miit configurations.
var miitAssetsPath string
var indexPagePath string
var scriptPath string
var sdpWaitTimeout time.Duration

func init() {
	// Load asset configuration paths.
	miitAssetsPath = config.GetString("MIIT_ASSETS_PATH")
	indexPagePath = config.GetString("MIIT_INDEX_PAGE_PATH")
	scriptPath = config.GetString("MIIT_JAVASCRIPT_PATH")
	sdpWaitTimeout = config.GetMilliseconds("MIIT_SDP_WAIT_TIMEOUT")

	// Obtain the root router group.
	root := GetRoot()

	// Create router group for miit assets.
	// TODO: remove this when HTTP/2 server push is available.
	miitGroup := root.Group("miit")
	miitGroup.Static("/", miitAssetsPath)

	// Create router group for miiting module and register handlers.
	miitingsGroup := root.Group("miitings")
	miitingsGroup.Use(middleware.Body(1024))
	miitingsGroup.GET("", RedirectRandomMiiting)
	miitingsGroup.GET(":miiting", GetMiiting)
	miitingsGroup.POST(":miiting", CreateAndJoinMiiting)
	miitingsGroup.DELETE(":miiting", DeleteMiiting)
	miitingsGroup.GET(":miiting/:type", ReceiveSDPAndICECandidates)
	miitingsGroup.POST(":miiting/:type", SendSDPAndICECandidates)
	// TODO: use PATCH and do partial updates instead.
	miitingsGroup.PUT(":miiting/:type", SendSDPAndICECandidates)
}

// RedirectRandomMiiting is a handler that redirects the client to a random miiting.
func RedirectRandomMiiting(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Iterate through the current miitings and randomly choose one to redirect to.
	var chosen string
	count := 2
	miitings.Range(func(key interface{}, value interface{}) bool {
		// Obtain the original key/value.
		miitingID := key.(string)
		miiting := value.(*miiting)

		// Make sure the meeting is not established and ongoing.
		if len(miiting.tokens) >= 2 {
			return true
		}

		// Roll the dice, see if we should pick this one.
		if rand.Int()%count == 0 {
			chosen = miitingID
			return false
		}

		// None is chosen, continue onto the next miiting.
		count++
		return true
	})

	// Set no-cache response headers first.
	ctx.Request.Header.Add("Cache-Control", "no-cache")
	ctx.Request.Header.Add("Cache-Control", "no-store")
	ctx.Request.Header.Add("Cache-Control", "must-revalidate")

	// Redirect to the target URL if a miiting was chosen.
	if len(chosen) > 0 {
		url := fmt.Sprintf("%s/%s", ctx.Request.URL.EscapedPath(), chosen)
		logger.Debug("Redirecting to randomly chosen miiting: [%s]", url)
		ctx.Redirect(http.StatusTemporaryRedirect, url)
		return
	}

	// No miiting was available, respond accordingly.
	abortWithStatusAndMessage(ctx, http.StatusNotFound,
		"Failed to find available miitings to join")
}

// GetMiiting returns the main index page for requests.
func GetMiiting(ctx *gin.Context) {
	// We return the main index page no matter the requested resource.
	ctx.File(indexPagePath)
}

// PushMiitAssets is the handler for pushing the miit assets to clients.
func PushMiitAssets(ctx *gin.Context) {
	// Get the miiting ID from path params.
	miitingID := ctx.Param("miiting")
	if len(miitingID) <= 0 {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid miiting ID: [%s]", miitingID)
		return
	}

	// Get the server push instance from context.
	pusher := ctx.Writer.Pusher()
	if pusher == nil {
		abortWithStatusAndMessage(ctx, http.StatusInternalServerError,
			"Failed to get HTTP/2 server push instance")
		return
	}

	// Push miit assets to client.
	assets := []string{indexPagePath, scriptPath}
	for _, asset := range assets {
		if err := pusher.Push(asset, nil); err != nil {
			abortWithStatusAndMessage(ctx, http.StatusInternalServerError,
				"Failed to push asset [%s]: %v", asset, err)
			return
		}
	}

	// We've done pushing, finish with empty JSON response.
	ctx.JSON(http.StatusOK, gin.H{})
}

// CreateAndJoinMiiting is the handler for requests creating a miiting.
func CreateAndJoinMiiting(ctx *gin.Context) {
	// Get the miiting ID from path params.
	miitingID := ctx.Param("miiting")
	if len(miitingID) <= 0 {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid miiting ID: [%s]", miitingID)
		return
	}

	// Get miiting initiator name from request body.
	body := map[string]string{}
	if err := ctx.BindJSON(&body); err != nil {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Failed to unmarshal miiting creation request: %v", err)
		return
	}

	// Check and create the miiting if it doesn't exist.
	value := miiting{}
	miitingIntf, exists := miitings.LoadOrStore(miitingID, &value)
	storedMiiting := miitingIntf.(*miiting)
	if !exists {
		storedMiiting.timestamp = time.Now()
		storedMiiting.tokens = append(storedMiiting.tokens, body["token"])
		storedMiiting.offerChan = make(chan *sessionDescription, 1)
		storedMiiting.answerChan = make(chan *sessionDescription, 1)
		ctx.JSON(http.StatusCreated, storedMiiting)
		return
	}

	// At most two users are allowed to join a miiting.
	if len(storedMiiting.tokens) < 2 {
		// Add to the list of participating user tokens. if
		storedMiiting.tokens = append(storedMiiting.tokens, body["token"])
		ctx.JSON(http.StatusOK, storedMiiting)
		return
	}

	// Two clients have already joined, reject the request.
	abortWithStatusAndMessage(ctx, http.StatusTooManyRequests,
		"Cannot join ongoing miiting [%s]", miitingID)
}

// DeleteMiiting is the handler for requests deleting a miiting.
func DeleteMiiting(ctx *gin.Context) {
	// Get the miiting ID from path params.
	miitingID := ctx.Param("miiting")
	if len(miitingID) <= 0 {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid miiting ID: [%s]", miitingID)
		return
	}

	// Get the token associated with joining this miiting..
	token := ctx.Query("token")

	// Lookup the requested miiting.
	value, exists := miitings.Load(miitingID)
	if !exists {
		abortWithStatusAndMessage(ctx, http.StatusNotFound,
			"Failed to find miiting [%s]", miitingID)
		return
	}
	miiting := value.(*miiting)

	// Delete the miiting from miitings map.if token is valid.
	if !tokenIsValid(miiting, token) {
		abortWithStatusAndMessage(ctx, http.StatusUnauthorized,
			"Unauthorized token: [%s]", token)
	} else {
		// Close open channels so waiting
		close(miiting.offerChan)
		close(miiting.answerChan)
		miitings.Delete(miitingID)
		ctx.JSON(http.StatusOK, gin.H{})
	}
}

// ReceiveSDPAndICECandidates is the handler for receiving SDP and ICE candidates.
func ReceiveSDPAndICECandidates(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Get the requested miiting ID from path params.
	miitingID := ctx.Param("miiting")
	if len(miitingID) <= 0 {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid miiting ID: [%s]", miitingID)
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
		abortWithStatusAndMessage(ctx, http.StatusNotFound,
			"Failed to find miiting [%s]", miitingID)
		return
	}
	miiting := value.(*miiting)

	// Check if the provided token is valid.
	token := ctx.Query("token")
	if !tokenIsValid(miiting, token) {
		abortWithStatusAndMessage(ctx, http.StatusUnauthorized,
			"Unauthorized token: [%s]", token)
		return
	}

	// Get the requested SDP channel from our miiting.
	var sdpChan chan *sessionDescription
	if sdpType == "offer" {
		sdpChan = miiting.offerChan
	} else if sdpType == "answer" {
		sdpChan = miiting.answerChan
	} else {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid SDP type: [%s]", sdpType)
		return
	}

	// Read & wait for the SDP to be submitted by the other client.
	var sdp *sessionDescription
	select {
	case sdp = <-sdpChan:
	case <-time.After(sdpWaitTimeout):
	}

	// Respond with error code if waiting for the description has timed out.
	if sdp == nil {
		abortWithStatusAndMessage(ctx, http.StatusGatewayTimeout,
			"Timed-out waiting for description from peer")
		return
	}

	// Return the requested SDP and/or ICE candidates.
	if iceCandidatesOnly {
		ctx.JSON(http.StatusOK, sdp.IceCandidates)
	} else {
		ctx.JSON(http.StatusOK, sdp)
	}
}

// SendSDPAndICECandidates is the handler for sending SDP and ICE candidates.
func SendSDPAndICECandidates(ctx *gin.Context) {
	// Get the requested miiting ID from path params.
	miitingID := ctx.Param("miiting")
	if len(miitingID) <= 0 {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid miiting ID: [%s]", miitingID)
		return
	}

	// Get the requested SDP type from path params.
	sdpType := ctx.Param("type")
	if len(sdpType) <= 0 {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid SDP type: [%s]", sdpType)
		return
	}

	// Extract the SDP from request body.
	sdp := sessionDescription{}
	if err := ctx.BindJSON(&sdp); err != nil {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Failed to extract SDP from request body: %v", err)
		return
	}

	// Lookup the requested miiting.
	value, exists := miitings.Load(miitingID)
	if !exists {
		abortWithStatusAndMessage(ctx, http.StatusNotFound,
			"Failed to find miiting [%s]", miitingID)
		return
	}
	miiting := value.(*miiting)

	// Check if the provided token is valid.
	token := ctx.Query("token")
	if !tokenIsValid(miiting, token) {
		abortWithStatusAndMessage(ctx, http.StatusUnauthorized,
			"Unauthorized token: [%s]", token)
		return
	}

	// Get the requested SDP from our miiting.
	if sdpType == "offer" && miiting.offerChan != nil {
		// Send the submitted offer over the offer channel.
		miiting.offerChan <- &sdp
	} else if sdpType == "answer" && miiting.answerChan != nil {
		// Send the submitted answer over the answer channel.
		miiting.answerChan <- &sdp
	} else {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid SDP type: [%s]", sdpType)
		return
	}

	// Respond with empty JSON.
	ctx.JSON(http.StatusOK, gin.H{})
}

// Check if the provided token is in our miiting tokens list.
func tokenIsValid(miiting *miiting, token string) bool {
	// Iterate through all tokens in our miiting.
	exists := false
	for idx := range miiting.tokens {
		if miiting.tokens[idx] == token {
			exists = true
			break
		}
	}

	return exists
}

// Abort request processing and respond with error message.
func abortWithStatusAndMessage(ctx *gin.Context, status int,
	format string, arguments ...interface{}) {
	logger := middleware.GetLogger(ctx)
	message := fmt.Sprintf(format, arguments...)
	ctx.AbortWithStatusJSON(status, gin.H{"error": message})
	logger.Error(message)
}

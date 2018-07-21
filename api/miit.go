package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/jswirl/miit/api/middleware"
	"github.com/jswirl/miit/assets"
	"github.com/jswirl/miit/config"
	"github.com/jswirl/miit/global"
	"github.com/jswirl/miit/logging"
)

// miiting is the object representing a miiting.
type miiting struct {
	// All fields are unexported, no json tag needed.
	id         string
	ctx        context.Context
	cancel     context.CancelFunc
	timestamp  int64
	tokens     map[string]*int64
	offerChan  chan interface{}
	answerChan chan interface{}
	deleteChan chan bool
}

// sessionDescription is the model of a offer/answer session description.
type sessionDescription struct {
	Name        string           `json:"name"`
	Description *json.RawMessage `json:"description"`
}

// iceCandidate is the struct representing an ICE candidate of a peer.
type iceCandidate struct {
	Candidate     string `json:"candidate"`
	SdpMid        string `json:"sdpMid"`
	SdpMLineIndex uint   `json:"sdpMLineIndex"`
}

// miitings contains all current miitings. miitingsMutex is used to
// synchronize deletion of a miiting between multiple goroutines.
var miitings sync.Map

//go:generate go-assets-builder -p assets -o ../assets/assets.go ../assets
// miitAssetsServer handles the embedded assets from our in-memory filesystem.
var miitAssetServer = http.FileServer(assets.Assets)

// Parameter error type to signal parameter extraction failed.
var errParameterExtractionFailed = errors.New("parameter extraction failed")

// miit configurations.
var sdpWaitTimeout time.Duration
var keepAliveInterval time.Duration
var keepAliveTimeout time.Duration
var keepAliveTimeoutNanoseconds int64

func init() {
	// Load configuration values.
	sdpWaitTimeout = config.GetMilliseconds("MIIT_SDP_WAIT_TIMEOUT")
	keepAliveInterval = config.GetMilliseconds("MIIT_KEEPALIVE_INTERVAL")
	keepAliveTimeout = config.GetMilliseconds("MIIT_KEEPALIVE_TIMEOUT")
	keepAliveTimeoutNanoseconds = keepAliveTimeout.Nanoseconds()

	// Setup handlers for assets and random miiting requests.
	GetRoot().GET("/random", RedirectToRandomMiiting)
	GetRoot().GET("/assets/:asset", GetMiitAsset)

	// Setup miiting module and register handlers.
	// TODO: use PushMiitAssets when HTTP/2 server push is ready.
	miitingsGroup := GetRoot().Group("miitings")
	miitingsGroup.POST("", CreateAndJoinMiiting)
	miitingsGroup.GET(":miiting", GetMiiting)
	miitingsGroup.PATCH(":miiting", KeepAlive)
	miitingsGroup.DELETE(":miiting", DeleteMiiting)
	miitingsGroup.POST(":miiting", SendDescription)
	miitingsGroup.GET(":miiting/:sdp_type", ReceiveDescription)
	miitingsGroup.POST(":miiting/:sdp_type", SendIceCandidates)
	miitingsGroup.GET(":miiting/:sdp_type/ice_candidates",
		ReceiveIceCandidates)
}

// RedirectToRandomMiiting is a handler that redirects the client to a random miiting.
func RedirectToRandomMiiting(ctx *gin.Context) {
	// Get logger instance.
	logger := middleware.GetLogger(ctx)

	// Iterate through the current miitings and randomly choose one to redirect to.
	var chosen string
	count := 1
	miitings.Range(func(key interface{}, value interface{}) bool {
		// Obtain the original key/value.
		miitingID := key.(string)
		miiting := value.(*miiting)

		// Make sure the meeting is not established and ongoing.
		// "cafeteria" is reserved for Zhe & Mao.
		if len(miiting.tokens) >= 2 ||
			miitingID == "cafeteria" {
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
		url := fmt.Sprintf("/%s", chosen)
		logger.Debug("Redirecting to randomly chosen miiting: [%s]", url)
		ctx.Redirect(http.StatusTemporaryRedirect, url)
		return
	}

	// No miiting was available, respond with not found page.
	serveMiitAsset(ctx, "/assets/notfound.html")
}

// GetMiiting is the handler for miiting bootstrap page requests.
func GetMiiting(ctx *gin.Context) {
	// Serve miiting bootstrap page from in-memory filesystem.
	serveMiitAsset(ctx, "/assets/miit.html")
}

// GetMiitAsset is the handler for miit asset requests.
func GetMiitAsset(ctx *gin.Context) {
	// Respond with requested asset.
	miitAssetServer.ServeHTTP(ctx.Writer, ctx.Request)
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
	assets := []string{
		"assets/miit.html",
		"assets/notfound.html",
		"assets/miit.js",
		"assets/quack.wav"}
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
	// Get miiting initiator name from request body.
	body := map[string]map[string]string{}
	if err := ctx.BindJSON(&body); err != nil {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Failed to unmarshal miiting creation request: %v", err)
		return
	}

	// Get miiting ID, there should be only one key, so we pick the first.
	var miitingID, token string
	for key, val := range body {
		miitingID = key
		token = val["token"]
		break
	}

	// Check and create the miiting if it doesn't exist.
	value := miiting{}
	miitingIntf, exists := miitings.LoadOrStore(miitingID, &value)
	storedMiiting, _ := miitingIntf.(*miiting)
	if !exists {
		storedMiiting.id = miitingID
		nowNano := int64(time.Now().Nanosecond())
		storedMiiting.timestamp = nowNano
		storedMiiting.tokens = map[string]*int64{}
		storedMiiting.tokens[token] = &nowNano
		storedMiiting.offerChan = make(chan interface{}, 1)
		storedMiiting.answerChan = make(chan interface{}, 1)
		storedMiiting.deleteChan = make(chan bool, 2)
		storedMiiting.ctx, storedMiiting.cancel =
			context.WithCancel(global.Context)
		go miitingMonitor(storedMiiting)
		ctx.JSON(http.StatusCreated, storedMiiting)
		return
	}

	// At most two users are allowed to join a miiting.
	if len(storedMiiting.tokens) < 2 {
		// Add to the list of participating user tokens. if
		nowNano := int64(time.Now().Nanosecond())
		storedMiiting.tokens[token] = &nowNano
		ctx.JSON(http.StatusOK, storedMiiting)
		return
	}

	// Two clients have already joined, reject the request.
	abortWithStatusAndMessage(ctx, http.StatusTooManyRequests,
		"Cannot join ongoing miiting [%s]", miitingID)
}

// KeepAlive is the handler for keep-alive requests.
func KeepAlive(ctx *gin.Context) {
	// Extract parameters from request.
	miiting, _, token, err := extractParameters(ctx, false)
	if err != nil {
		return
	}

	// Update timestamps.
	nowNano := int64(time.Now().Nanosecond())
	atomic.StoreInt64(&miiting.timestamp, nowNano)
	atomic.StoreInt64(miiting.tokens[token], nowNano)

	// Done refreshing timestamps, return empty response.
	ctx.JSON(http.StatusOK, gin.H{})
}

// DeleteMiiting is the handler for requests deleting a miiting.
func DeleteMiiting(ctx *gin.Context) {
	// Extract parameters from request.
	miiting, _, _, err := extractParameters(ctx, false)
	if err != nil {
		return
	}

	// Notify monitor to delete miiting.
	miiting.deleteChan <- true
	ctx.JSON(http.StatusOK, gin.H{})
}

// ReceiveDescription is the handler for receiving a SDP offer / answer.
func ReceiveDescription(ctx *gin.Context) {
	// Extract parameters from request.
	miiting, sdpType, _, err := extractParameters(ctx, true)
	if err != nil {
		return
	}

	// Get the channel cooresponding to our type from our miiting.
	var sdpChan chan interface{}
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
	case data := <-sdpChan:
		sdp = data.(*sessionDescription)
	case <-time.After(sdpWaitTimeout):
	case <-miiting.ctx.Done():
	}

	// Respond with error code if waiting for the description has timed out.
	if sdp == nil {
		abortWithStatusAndMessage(ctx, http.StatusGatewayTimeout,
			"No description received from peer")
		return
	}

	// Respond with the received SDP.
	ctx.JSON(http.StatusOK, sdp)
}

// SendDescription is the handler for sending a SDP offer / answer.
func SendDescription(ctx *gin.Context) {
	// Extract parameters from request.
	miiting, _, _, err := extractParameters(ctx, false)
	if err != nil {
		return
	}

	// Prepare the struct to receive session description entity.
	sdpEntity := struct {
		Offer  *sessionDescription `json:"offer,omitempty"`
		Answer *sessionDescription `json:"answer,omitempty"`
	}{nil, nil}

	// Extract the SDP from request body.
	if err := ctx.BindJSON(&sdpEntity); err != nil {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Failed to extract SDP from request body: %v", err)
		return
	}

	// Get the requested SDP from our miiting.
	if sdpEntity.Offer != nil && miiting.offerChan != nil {
		// Send the submitted offer over the offer channel.
		miiting.offerChan <- sdpEntity.Offer
	} else if sdpEntity.Answer != nil && miiting.answerChan != nil {
		// Send the submitted answer over the answer channel.
		miiting.answerChan <- sdpEntity.Answer
	} else {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Failed to unmarshal offer / answer from request")
		return
	}

	// Respond with empty JSON.
	ctx.JSON(http.StatusOK, gin.H{})
}

// ReceiveIceCandidates is the handler for receiving ICE candidates.
func ReceiveIceCandidates(ctx *gin.Context) {
	// Extract parameters from request.
	miiting, sdpType, _, err := extractParameters(ctx, true)
	if err != nil {
		return
	}

	// Get the channel cooresponding to our type from our miiting.
	var iceCandidatesChan chan interface{}
	if sdpType == "offer" {
		iceCandidatesChan = miiting.offerChan
	} else if sdpType == "answer" {
		iceCandidatesChan = miiting.answerChan
	} else {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid SDP type: [%s]", sdpType)
		return
	}

	// Read & wait for the SDP to be submitted by the other client.
	var iceCandidates []*iceCandidate
	select {
	case data := <-iceCandidatesChan:
		iceCandidates = data.([]*iceCandidate)
	case <-time.After(sdpWaitTimeout):
	case <-miiting.ctx.Done():
	}

	// Respond with error code if waiting for ICE candidates has timed out.
	if iceCandidates == nil {
		abortWithStatusAndMessage(ctx, http.StatusGatewayTimeout,
			"No ICE candidates received from peer")
		return
	}

	// Respond with the received ICE candidates.
	ctx.JSON(http.StatusOK, iceCandidates)
}

// SendIceCandidates is the handler for sending ICE candidates.
func SendIceCandidates(ctx *gin.Context) {
	// Extract parameters from request.
	miiting, sdpType, _, err := extractParameters(ctx, true)
	if err != nil {
		return
	}

	// Prepare the struct to receive ICE candidates entity.
	iceCandidatesEntity := struct {
		IceCandidates []*iceCandidate `json:"ice_candidates"`
	}{nil}

	// Extract the ICE candidates from request body.
	if err := ctx.BindJSON(&iceCandidatesEntity); err != nil {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Failed to extract ICE candidates from request body: %v", err)
		return
	}

	// Send the submitted ICE candidates over our miiting channel.
	if sdpType == "offer" && miiting.offerChan != nil {
		// Send the submitted ICE candidates over the offer channel.
		miiting.offerChan <- iceCandidatesEntity.IceCandidates
	} else if sdpType == "answer" && miiting.answerChan != nil {
		// Send the submitted ICE candidates over the answer channel.
		miiting.answerChan <- iceCandidatesEntity.IceCandidates
	} else {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid SDP type: [%s]", sdpType)
		return
	}

	// Respond with empty JSON.
	ctx.JSON(http.StatusOK, gin.H{})
}

// serveMiitAsset responds with content of in-memory assets.
func serveMiitAsset(ctx *gin.Context, miitAssetPath string) {
	// Open miit asset file from in-memory filesystem.
	miitAssetFile, err := assets.Assets.Open(miitAssetPath)
	if err != nil {
		abortWithStatusAndMessage(ctx, http.StatusInternalServerError,
			"Failed to open %s: %v", miitAssetPath, err)
		return
	}

	// Respond with miit asset content.
	http.ServeContent(ctx.Writer, ctx.Request,
		miitAssetPath, time.Now(), miitAssetFile)
}

// extractParameters extracts common parameters from a request.
func extractParameters(ctx *gin.Context, typeRequired bool) (
	*miiting, string, string, error) {
	// Get the requested miiting ID from path params.
	miitingID := ctx.Param("miiting")
	if len(miitingID) <= 0 {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid miiting ID: [%s]", miitingID)
		return nil, "", "", errParameterExtractionFailed
	}

	// Lookup the requested miiting.
	value, exists := miitings.Load(miitingID)
	if !exists {
		abortWithStatusAndMessage(ctx, http.StatusNotFound,
			"Failed to find miiting [%s]", miitingID)
		return nil, "", "", errParameterExtractionFailed
	}
	miiting := value.(*miiting)

	// Get the requested SDP type from path params.
	sdpType := ctx.Param("sdp_type")
	if len(sdpType) <= 0 && typeRequired {
		abortWithStatusAndMessage(ctx, http.StatusBadRequest,
			"Invalid SDP type: [%s]", sdpType)
		return nil, "", "", errParameterExtractionFailed
	}

	// Check if the provided token is valid.
	token := ctx.Query("token")
	if !tokenIsValid(miiting, token) {
		abortWithStatusAndMessage(ctx, http.StatusUnauthorized,
			"Unauthorized token: [%s]", token)
		return nil, "", "", errParameterExtractionFailed
	}

	return miiting, sdpType, token, nil
}

// Abort request processing and respond with error message.
func abortWithStatusAndMessage(ctx *gin.Context, status int,
	format string, arguments ...interface{}) {
	logger := middleware.GetLogger(ctx)
	message := fmt.Sprintf(format, arguments...)
	ctx.AbortWithStatusJSON(status, gin.H{"error": message})
	logger.Error(message)
}

// miitingMonitor is the goroutine for monitoring the state of a miiting.
func miitingMonitor(miiting *miiting) {
	// Keep a copy of miiting ID, since it may be deleted while sleeping.
	miitingID := miiting.id
	defer logging.Debug("miiting [%s] monitor exited", miitingID)

	// Setup delete miiting function.
	deleteMiiting := func() {
		logging.Info("Deleting miiting [%s]...", miiting.id)
		defer miitings.Delete(miiting.id)
		defer miiting.cancel()
		close(miiting.offerChan)
		close(miiting.answerChan)
	}

	// Keep monitoring miiting status until context is cancelled.
	for miiting.ctx.Err() == nil {
		nowNano := int64(time.Now().Nanosecond())

		// Perform session timeout invalidation.
		elapsed := nowNano - atomic.LoadInt64(&miiting.timestamp)
		if elapsed > keepAliveTimeoutNanoseconds {
			logging.Info("miiting [%s] has timed-out", miitingID)
			deleteMiiting()
			return
		}

		// Perform individual participant timeout invalidation.
		for token, timestamp := range miiting.tokens {
			elapsed := nowNano - atomic.LoadInt64(timestamp)
			if elapsed > keepAliveTimeoutNanoseconds {
				logging.Info("Token [%s] of [%s] has timed-out",
					token, miitingID)
				deleteMiiting()
				return
			}
		}

		// Sleep until next invalidation check.
		select {
		case <-miiting.ctx.Done():
		case <-time.After(keepAliveTimeout):
		case <-miiting.deleteChan:
			deleteMiiting()
			return
		}
	}
}

// Check if the provided token is in our miiting tokens;
func tokenIsValid(miiting *miiting, token string) bool {
	// Iterate through all tokens in our miiting.
	_, exists := miiting.tokens[token]
	return exists
}

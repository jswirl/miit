/* Author: Pu-Chen Mao (pujnmao@gmail.com) */

/* API server URL */
var apiUrl = window.location.href

/* Our user name to be displayed */
var name = 'anonymous';

/* Our role in the miiting session. */
var isInitiator = true;

/* WebRTC components and variables */
var rtcPeerConnection;
var LocalVideo, RemoteVideo;
var localIceCandidates = [], remoteIceCandidates = [];

/* Media Constraints */
var mediaConstraints = {
    audio: true,
    //video: true,
    optional: {
        DtlsSrtpKeyAgreement: true,
    },
    mandatory: {
        OfferToReceiveAudio: true,
        //OfferToReceiveVideo: true,
        width: 1280,
        height: 720,
        minFrameRate: 30,
    },
};

/* ICE Server Configurations */
var peerConnectionConfig = {'iceServers': [
    {'url': 'stun:stun.l.google.com:19302'},
    {'url': 'stun:stun.services.mozilla.com'},
]}

function main() {
    // Initialize browser Media API & DOM elements.
    initialize();

    // Prompt user for name.
    name = prompt('Please enter your name:', name);

    // Start miiting setup sequence here.
    run();
}

function initialize() {
    // Prepare video elements.
    LocalVideo = document.getElementById('LocalVideo');
    RemoteVideo = document.getElementById('RemoteVideo');

    // Polyfill to setup browser WebRTC components.
    window.URL =
        window.URL ||
        window.mozURL ||
        window.webkitURL ||
        window.msURL;
    window.RTCPeerConnection =
        window.RTCPeerConnection ||
        window.mozRTCPeerConnection ||
        window.webkitRTCPeerConnection;
    window.RTCIceCandidate =
        window.RTCIceCandidate ||
        window.mozRTCIceCandidate ||
        window.webkitRTCIceCandidate;
    window.RTCSessionDescription =
        window.RTCSessionDescription ||
        window.mozRTCSessionDescription ||
        window.webkitRTCSessionDescription;
    window.onbeforeunload = adjournMiiting;
}

function run() {
    // Branched continuation of the the chain based on our role.
    var continueBasedOnRole = function(isInitiator) {
        if (isInitiator) {
            // We are the initiator of the miiting.
            return createOffer().catch(errorHandler).
                then(setLocalDescription, errorHandler).
                then(sendLocalDescription, errorHandler).
                then(requestRemoteDescription, errorHandler).
                then(receiveRemoteDescription, errorHandler).
                then(setRemoteDescription, errorHandler);
        } else {
            // We are the joiner of the miiting.
            return requestRemoteDescription().catch(errorHandler).
                then(receiveRemoteDescription, errorHandler).
                then(setRemoteDescription, errorHandler).
                then(createAnswer, errorHandler).
                then(setLocalDescription, errorHandler).
                then(sendLocalDescription, errorHandler);
        }
    };

    // Execute miiting setup by running sequence of chained functions.
    navigator.mediaDevices.getUserMedia(mediaConstraints).
        then(setLocalMediaStream, errorHandler).
        then(createPeerConnection, errorHandler).
        then(tryCreateMiiting, errorHandler).
        then(determineMiitingRole, errorHandler).
        then(continueBasedOnRole, errorHandler);
}

function setLocalMediaStream(localStream) {
    setStatus('Initialized browser Media API.');
    LocalVideo.srcObject = localStream;
    return localStream;
}

function createPeerConnection(localStream) {
    setStatus('Creating RTCPeerConnection...');
    rtcPeerConnection = new RTCPeerConnection(peerConnectionConfig);
    rtcPeerConnection.onicecandidate = onLocalIceCandidates;
    rtcPeerConnection.ontrack = onRemoteStream;
    localStream.getTracks().forEach(
        track => rtcPeerConnection.addTrack(track, localStream));
}

function tryCreateMiiting() {
    setStatus('Trying to create miiting...');

    // Compose request JSON.
    var json = JSON.stringify({
        'initiator': name,
    });

    // Return Promise of the request creating our miiting.
    return request('POST', apiUrl, json, true);
}

function determineMiitingRole(xhr) {
    // Determine our role based on received status code.
    if (xhr.status == 201) {
        isInitiator = true;
        return true;
    } else if (xhr.status == 200) {
        isInitiator = false;
        return false;
    }

    // By default, just let us be the joiner.
    isInitiator = false;
    return false;
}

function onLocalIceCandidates(event) {
    if (event.candidate == null) {
        setStatus('Finished gathering local ICE candidates.');
    } else {
        setStatus('Gathering local ICE candidates...');
        localIceCandidates.push(event.candidate);
        console.log(event.candidate);
    }
}

function onRemoteStream(event) {
    setStatus('Received remote stream.');
    var remoteStream = event.streams[0];
    RemoteVideo.srcObject = remoteStream;
    remoteStream.getTracks().forEach(
        track => rtcPeerConnection.addTrack(track, remoteStream));
}

function setLocalDescription(description) {
    setStatus('Setting local description...');
    return rtcPeerConnection.setLocalDescription(description);
}

function setRemoteDescription(description) {
    setStatus('Setting remote description...');
    return rtcPeerConnection.setRemoteDescription(description);
}

function createOffer() {
    setStatus('Creating offer...');
    return rtcPeerConnection.createOffer();
}

function createAnswer() {
    setStatus('Creating answer...');
    return rtcPeerConnection.createAnswer();
}

function sendLocalDescription() {
    setStatus('Sending local SDP and ICE information...');

    // Compose local SDP and ICE candidates JSON.
    var json = JSON.stringify({
        'name': name,
        'type': localSDPType(),
        'description': rtcPeerConnection.localDescription.sdp,
        'ice_candidates': localIceCandidates,
    });

    // Return promise of the request submitting our local description.
    return request('POST', apiUrl + '/' + localSDPType(), json, true);
}

function requestRemoteDescription() {
    setStatus('Receiving remote SDP and ICE information...');
    // Return promise of the request retrieving the remote description.
    return request('GET', apiUrl + '/' + remoteSDPType(), null, true);
}

function receiveRemoteDescription(xhr) {
    setStatus('Receiving remote SDP and ICE information...');

    // Parse received remote description and compose JSEP description.
    var json = JSON.parse(xhr.responseText);
    var jsep = {
        'type': json.type,
        'sdp': json.description,
    };

    // Create and return the remote session description object.
    return new RTCSessionDescription(jsep);
}

function adjournMiiting() {
    // Destroy the miiting object if we are the miiting initiator.
    if (isInitiator) {
        request('DELETE', apiUrl, null, true);
    }
}

function request(method, url, body, async) {
    return new Promise(function(resolve, reject) {
        // Setup new request.
        var xhr = new XMLHttpRequest();
        xhr.open(method, url, async);
        xhr.setRequestHeader('Content-type', 'application/json');

        // Setup response handler.
        xhr.onload = function() {
            if (xhr.status >= 200 && xhr.status < 400)
                resolve(xhr);
            else {
                setStatus(xhr.responseText)
                reject(xhr);
            }
        }

        // Setup request exception handler.
        exceptionHandler = function() {
            reject('request failed due to timeout / network error');
        }

        // Setup error & request timeout handlers.
        xhr.onerror = exceptionHandler
        xhr.ontimeout = exceptionHandler

        // Send our request here.
        xhr.send(body);
    });
}


function localSDPType() {
    return isInitiator ? 'offer' : 'answer';
}

function remoteSDPType() {
    return isInitiator ? 'answer' : 'offer';
}

function setStatus(message) {
    document.getElementById('Status').value = message;
    console.log(message);
}

function errorHandler(error) {
    console.log(error);
}

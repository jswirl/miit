/* Author: Pu-Chen Mao (pujnmao@gmail.com) */

/* API server URL */
var apiUrl = window.location.href

/* Our user name to be displayed */
var name = 'anonymous';

/* The token used to create a miiting. */
var token = generateToken();

/* Our role in the miiting session. */
var isInitiator = true;

/* WebRTC components and variables */
var rtcPeerConnection;
var LocalVideo, LocalName, RemoteVideo, RemoteVideo;
var localIceCandidates = [];

/* ICE Server Configurations */
var peerConnectionConfig = {
    iceServers: [
        { url: 'stun:stun.l.google.com:19302' },
        { url: 'stun:stun.services.mozilla.com' },
    ],
    bundlePolicy: 'max-compat',
    iceTransportPolicy: 'all',

}

function main() {
    // Initialize browser Media API & DOM elements.
    initialize();

    // Prompt user for name.
    name = prompt('Please enter your name:', name);
    LocalName.innerHTML = name;

    // Start miiting setup sequence here.
    run();
}

function initialize() {
    // Prepare video elements.
    LocalVideo = document.getElementById('LocalVideo');
    RemoteVideo = document.getElementById('RemoteVideo');
    LocalName= document.getElementById('LocalName');
    RemoteName= document.getElementById('RemoteName');

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
    window.onunload = adjournMiiting;
    window.onbeforeunload = adjournMiiting;
    window.onpagehide = adjournMiiting;
}

function run() {
    // Branched continuation of the the chain based on our role.
    var continueBasedOnRole = function() {
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

    // Check if MediaDevices API is available.
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        var message = "MediaDevices API not available";
        console.log(message);
        alert(message);
        return;
    }

    // Execute promise chain for miiting setup.
    navigator.mediaDevices.enumerateDevices().
        then(setMediaDeviceConstraints, errorHandler).
        then(getUserMedia, errorHandler).
        then(setLocalMediaStream, errorHandler).
        then(createPeerConnection, errorHandler).
        then(tryCreateMiiting, errorHandler).
        then(determineMiitingRole, errorHandler).
        then(continueBasedOnRole, errorHandler).
        then(sendLocalIceCandidates, errorHandler).
        then(requestRemoteIceCandidates, errorHandler).
        then(receiveRemoteIceCandidates, errorHandler).
        then(setRemoteIceCandidates, errorHandler);
}

function setMediaDeviceConstraints(devices) {
    console.log('Detected media devices: ' + JSON.stringify(devices, null, 4));

    // Gather audio & video devices;
    var cameras = devices.filter(device => device.kind == "videoinput");
    var microphones = devices.filter(device => device.kind == "audioinput");

    // Compose constraints based on available media devices.
    var constraints = {
        audio: microphones.length > 0,
        video: cameras.length > 0 ? {
            width: { exact: 640 },
            height: { exact: 480 },
        } : false,
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        optional: {
            DtlsSrtpKeyAgreement: true,
        },
    };

    // Show the media constraints being used to initialize media devices.
    console.log('Using constraints: ' + JSON.stringify(constraints, null, 4));

    return constraints;
}

function getUserMedia(constraints) {
    console.log('Initializing browser Media API...');
    // Return promise to request for media device access.
    return navigator.mediaDevices.getUserMedia(constraints);
}

function setLocalMediaStream(localStream) {
    console.log('Initialized browser Media API and local medida stream.');
    // Set local video stream source to the initialized stream.
    LocalVideo.srcObject = localStream;
    return localStream;
}

function createPeerConnection(localStream) {
    console.log('Creating RTCPeerConnection...');
    rtcPeerConnection = new RTCPeerConnection(peerConnectionConfig);
    rtcPeerConnection.onicecandidate = storeLocalIceCandidate;
    rtcPeerConnection.ontrack = setRemoteMediaTrack;
    localStream.getTracks().forEach(track =>
        rtcPeerConnection.addTrack(track, localStream));
    rtcPeerConnection.addStream(localStream);
}

function tryCreateMiiting() {
    console.log('Trying to create miiting...');

    // Compose request JSON.
    var json = JSON.stringify({
        'initiator': name,
        'token': token,
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

function createOffer() {
    console.log('Creating offer...');
    return rtcPeerConnection.createOffer();
}

function setLocalDescription(description) {
    console.log('Setting local description: ' +
        JSON.stringify(description, null, 4));
    return rtcPeerConnection.setLocalDescription(description);
}

function sendLocalDescription() {
    console.log('Sending local description...');

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
    console.log('Requesting remote description...');
    // Return promise of the request retrieving the remote description.
    return request('GET', apiUrl + '/' + remoteSDPType(), null, true);
}

function receiveRemoteDescription(xhr) {
    console.log('Received remote description.');

    // Parse received remote description and compose JSEP description.
    var json = JSON.parse(xhr.responseText);
    var jsep = {
        'type': json.type,
        'sdp': json.description,
    };

    // Set the remote peer name.
    RemoteName.innerHTML = json.name;

    // Create and return the remote session description object.
    return new RTCSessionDescription(jsep);
}

function setRemoteDescription(description) {
    console.log('Setting remote description: ' +
        JSON.stringify(description, null, 4));
    return rtcPeerConnection.setRemoteDescription(description);
}

function createAnswer() {
    console.log('Creating answer...');
    return rtcPeerConnection.createAnswer();
}

// NOTE: for laziness' sake, we just send to the same API endpoint to receive
// our ICE candidates, this will result in sending a redudant SDP, we should
// change to use partial updates with PATCH in the future.
function sendLocalIceCandidates() {
    console.log('Sending local ICE candidates...');

    // Compose local SDP and ICE candidates JSON.
    var json = JSON.stringify({
        'name': name,
        'type': localSDPType(),
        'description': rtcPeerConnection.localDescription.sdp,
        'ice_candidates': localIceCandidates,
    });

    // Return promise of the request submitting our local description.
    return request('PUT', apiUrl + '/' + localSDPType(), json, true);
}

function requestRemoteIceCandidates() {
    console.log('Requesting remote ICE candidates...');
    // Return promise of the request retrieving the remote description.
    return request('GET', apiUrl + '/' + remoteSDPType() +
        '?ice_only=true', null, true);
}

function receiveRemoteIceCandidates(xhr) {
    console.log('Received remote ICE candidates.');
    // Parse and return received remote ICE candidates.
    return JSON.parse(xhr.responseText);
}

function setRemoteIceCandidates(iceCandidates) {
    console.log('Setting remote ICE candidates: ' +
        JSON.stringify(iceCandidates, null, 4));
    // Add each received ICE canddiate to our RTCPeerConnection.
    iceCandidates.forEach(iceCandidate =>
        rtcPeerConnection.addIceCandidate(iceCandidate));
}

function storeLocalIceCandidate(event) {
    if (event.candidate == null) {
        console.log('Finished gathering local ICE candidates: ' +
            JSON.stringify(localIceCandidates));
    } else {
        localIceCandidates.push(event.candidate);
        console.log(event.candidate);
    }
}

function setRemoteMediaTrack(event) {
    console.log('Received remote stream.');
    RemoteVideo.srcObject = event.streams[0];
}


function adjournMiiting() {
    request('DELETE', apiUrl + '?token=' + token, null, true);
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
                console.log(xhr.responseText)
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

function generateToken() {
    var token = "";
    var runes = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (var i = 0; i < 16; i++) {
        token += runes.charAt(Math.floor(Math.random() * runes.length));
    }
    return token;
}

function localSDPType() {
    return isInitiator ? 'offer' : 'answer';
}

function remoteSDPType() {
    return isInitiator ? 'answer' : 'offer';
}

function errorHandler(error) {
    console.log(error);
    alert(JSON.stringify(error, null, 4));
}

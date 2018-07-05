/* Author: Pu-Chen Mao (pujnmao@gmail.com)
 * Dedicated to Zhe. */

/* API server URL */
var href = window.location.href
var miitingID = href.split('/').pop();
var miitingsUrl =  href.replace(miitingID, 'miitings');
var apiUrl = miitingsUrl + '/' + miitingID;

/* Our user name to be displayed */
var name = 'anonymous';

/* The token used to create and join a miiting. */
var token = generateToken();

/* Keep-alive task handle */
var keepAliveHandle;

/* Our role in the miiting session. */
var isInitiator = true;

/* WebRTC variables & HTML components */
var rtcPeerConnection, dataChannel;
var LocalVideo, LocalName, RemoteVideo, RemoteVideo;
var ToggleMessagesButton, Messages, MessageBarText, MessageBarButton;
var localIceCandidates = [];
var quack = new Audio('/files/quack.wav');

/* ICE Server Configurations */
var peerConnectionConfig = {
    iceServers: [
        { urls: 'stun:stunserver.org' },
        { urls: 'stun:stun.xten.com' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' },
    ],
    bundlePolicy: 'max-compat',
    iceTransportPolicy: 'all',
}

/* Media constraints. */
var constraints;

/* Codec preferences */
var preferredAudioCodec = 'opus';
var preferredVideoCodec = 'H264';

/* Video settings */
var videoSettings = {
    width: { min: 160, ideal: 320, max: 640 },
    height: { min: 120, ideal: 240, max: 480 },
    frameRate: { min: 5, ideal: 30, max: 30 }
}

function main() {
    // Initialize browser Media API & DOM elements.
    initialize();

    // Prompt user for name.
    name = prompt('Please enter your name:', name);
    if (name == null) {
        return;
    }

    LocalName.innerHTML = name;

    // Start miiting setup sequence here.
    run();
}

function initialize() {
    // Prepare HTML elements.
    LocalVideo = document.getElementById('LocalVideo');
    RemoteVideo = document.getElementById('RemoteVideo');
    LocalName = document.getElementById('LocalName');
    RemoteName = document.getElementById('RemoteName');
    ToggleMessagesButton = document.getElementById('ToggleMessagesButton');
    MessagesContainer = document.getElementById('MessagesContainer');
    Messages = document.getElementById('Messages');
    MessageBarText = document.getElementById('MessageBarText');
    MessageBarButton= document.getElementById('MessageBarButton');

    // Initialize HTML element state & handlers.
    Messages.scrollTop = Messages.scrollHeight;
    MessageBarText.addEventListener('keypress', handleMessageBarTextKey);
    MessageBarButton.addEventListener('click', sendMessageAndData);

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
    window.onpagehide = deleteMiiting;
    window.onbeforeunload = deleteMiiting;
    window.onunload = deleteMiiting;
}

function finalize() {
    // Stop sending keep-alives.
    clearInterval(keepAliveHandle);

    // Remove all tracks from remote video component.
    if (RemoteVideo.srcObject) {
        RemoteVideo.srcObject.getTracks().forEach(track => track.stop());
        RemoteVideo.srcObject = null;
    }

    // Remove all tracks from remote video component.
    if (LocalVideo.srcObject) {
        LocalVideo.srcObject.getTracks().forEach(track => track.stop());
        LocalVideo.srcObject = null;
    }

    // Close our RTCPeerConnection.
    if (rtcPeerConnection) {
        rtcPeerConnection.close();
        rtcPeerConnection = null;
    }
}

function run() {
    // Check if MediaDevices API is available.
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        var message = "MediaDevices API not available";
        console.log(message);
        alert(message);
        return;
    }

    // Branched continuation of our Promise chain based on our role.
    var continueBasedOnRole = function() {
        if (isInitiator) {
            return enumerateMediaDevices().catch(errorHandler).
                then(setMediaDeviceConstraints, errorHandler).
                then(getUserMedia, errorHandler).
                then(setLocalMediaStream, errorHandler).
                then(createOffer, errorHandler).
                then(adjustMediaCodecPriority, errorHandler).
                then(setLocalDescription, errorHandler).
                then(sendLocalDescription, errorHandler).
                then(requestRemoteDescription, errorHandler).
                then(receiveRemoteDescription, errorHandler).
                then(setRemoteDescription, errorHandler);
        } else {
            return requestRemoteDescription().catch(errorHandler).
                then(receiveRemoteDescription, errorHandler).
                then(setRemoteDescription, errorHandler).
                then(enumerateMediaDevices, errorHandler).
                then(setMediaDeviceConstraints, errorHandler).
                then(getUserMedia, errorHandler).
                then(setLocalMediaStream, errorHandler).
                then(createAnswer, errorHandler).
                then(adjustMediaCodecPriority, errorHandler).
                then(setLocalDescription, errorHandler).
                then(sendLocalDescription, errorHandler);
        }
    };

    // Execute promise chain for miiting setup.
    tryCreateMiiting().catch(abortOnError).
        then(determineMiitingRole, abortOnError).
        then(beginKeepAlive, abortOnError).
        then(createPeerConnection, abortOnError).
        then(setupDataChannel, abortOnError).
        then(continueBasedOnRole, abortOnError).
        then(sendLocalIceCandidates, abortOnError).
        then(requestRemoteIceCandidates, abortOnError).
        then(receiveRemoteIceCandidates, abortOnError).
        then(setRemoteIceCandidates, abortOnError).
        catch(showError, showError);
}

function tryCreateMiiting() {
    console.log('Trying to create miiting...');

    // Compose request JSON.
    var miiting = {};
    miiting[miitingID] = {
        'token': token,
    };

    return request('POST', miitingsUrl, JSON.stringify(miiting), true);
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

    isInitiator = false;
}

function beginKeepAlive() {
    keepAliveHandle = setInterval(sendKeepAliveRequest, 10000);
}

function sendKeepAliveRequest() {
    request('PATCH', apiUrl + '?token=' + token, '{}', true).
        then(handleKeepAliveResponse, abortOnError).
        catch(showError, showError);
}

function handleKeepAliveResponse(xhr) {
    if (xhr.status >= 400) {
        teardown();
    }
}

function createPeerConnection() {
    console.log('Creating RTCPeerConnection...');

    // Create the  peer connection to be used for media and data.
    rtcPeerConnection = new RTCPeerConnection(peerConnectionConfig);
    rtcPeerConnection.onicecandidate = storeLocalIceCandidate;
    rtcPeerConnection.ontrack = setRemoteMediaTrack;
    rtcPeerConnection.onremovetrack = handleMediaTrackRemoved;
    rtcPeerConnection.oniceconnectionstatechange = handleIceConnectionState;
    rtcPeerConnection.onicegatheringstatechange = handleStateChangeEvent;
    rtcPeerConnection.onsignalingstatechange = handleStateChangeEvent;
}

function setupDataChannel() {
    console.log('Creating DataChannel...');

    // Create the datachannel from our peer connection.
    if (isInitiator) {
        dataChannel = rtcPeerConnection.createDataChannel(null);
        console.log(dataChannel);
        dataChannel.onmessage = event =>
            addMessage(RemoteName.textContent, event.data);
    } else {
        rtcPeerConnection.ondatachannel = handleDataChannelConnected;
    }
}

function enumerateMediaDevices() {
    console.log('Detecting media devices...');
    return navigator.mediaDevices.enumerateDevices();
}

function setMediaDeviceConstraints(devices) {
    console.log('Detected media devices: ');
    console.log(devices);

    // Gather audio & video devices;
    var cameras = devices.filter(device => device.kind == "videoinput");
    var microphones = devices.filter(device => device.kind == "audioinput");

    // Compose constraints based on available media devices.
    constraints = {
        audio: microphones.length > 0,
        video: cameras.length > 0 ? videoSettings : false,
        optional: {
            DtlsSrtpKeyAgreement: true,
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            voiceActivityDetection: false,
        },
    };

    console.log('Using constraints: ');
    console.log(constraints);

    return constraints;
}

function getUserMedia(constraints) {
    console.log('Initializing browser Media API...');
    return navigator.mediaDevices.getUserMedia(constraints);
}

function setLocalMediaStream(localStream) {
    console.log('Initialized browser Media, adding tracks...');
    LocalVideo.srcObject = localStream;
    localStream.getTracks().forEach(track =>
       rtcPeerConnection.addTrack(track, localStream));
}

function createOffer() {
    console.log('Creating offer...');
    return rtcPeerConnection.createOffer(constraints.optional);
}

function adjustMediaCodecPriority(description) {
    console.log('Configuring preferred codecs...');

    // Iterate throuh all SDP lines and find media descriptions.
    var sdpLines = description.sdp.split('\r\n');
    var audioLineIndex, videoLineIndex, rtpmaps = {};
    for (var idx = 0; idx < sdpLines.length; idx++) {
        var sdpLine = sdpLines[idx];
        if (sdpLine.startsWith('m=audio')) {
            audioLineIndex = idx;
        } else if (sdpLine.startsWith('m=video')) {
            videoLineIndex = idx;
        } else if (sdpLine.startsWith('a=rtpmap')) {
            // a=rtpmap:110 telephone-event/48000
            var regex = /a=rtpmap:(\d+) (\w+)\/*/;
            var matches = sdpLine.match(regex)
            var payload = matches[1];
            var codec = matches[2];
            rtpmaps[payload] = codec;
        }
    }

    // Handle audio payload priority reordering.
    var audioLineParts = sdpLines[audioLineIndex].split(' ');
    for (var idx = 3, nextIdx = 3; idx < audioLineParts.length; idx++) {
        var audioCodec = rtpmaps[parseInt(audioLineParts[idx])];
        if (audioCodec.startsWith(preferredAudioCodec)) {
            var temp = audioLineParts[nextIdx];
            audioLineParts[nextIdx] = audioLineParts[idx];
            audioLineParts[idx] = temp;
            nextIdx++;
        }
    }
    sdpLines[audioLineIndex] = audioLineParts.join(' ');

    // Handle video payload priority reordering.
    var videoLineParts = sdpLines[videoLineIndex].split(' ');
    for (var idx = 3, nextIdx = 3; idx < videoLineParts.length; idx++) {
        var videoCodec = rtpmaps[parseInt(videoLineParts[idx])];
        if (videoCodec.startsWith(preferredVideoCodec)) {
            var temp = videoLineParts[nextIdx];
            videoLineParts[nextIdx] = videoLineParts[idx];
            videoLineParts[idx] = temp;
            nextIdx++;
        }
    }
    sdpLines[videoLineIndex] = videoLineParts.join(' ');

    // Reassemble adjusted SDP.
    description.sdp = sdpLines.join('\r\n');

    return description;
}

function setLocalDescription(description) {
    console.log('Setting local description: ');
    console.log(description);
    return rtcPeerConnection.setLocalDescription(description);
}

function sendLocalDescription() {
    console.log('Sending local description...');

    // Compose local SDP and ICE candidates JSON.
    var sdp = {}
    sdp[localSDPType()] = {
        'name': name,
        'description': rtcPeerConnection.localDescription.sdp,
    };

    return request('POST', apiUrl + '?token=' + token,
        JSON.stringify(sdp), true);
}

function requestRemoteDescription() {
    console.log('Requesting remote description...');

    // Show that we are now waiting for the other end to join.
    RemoteName.innerHTML = 'Waiting...';

    return request('GET', apiUrl + '/' + remoteSDPType() + '?token=' + token,
        null, true);
}

function receiveRemoteDescription(xhr) {
    console.log('Received remote description.');

    // Parse received remote description and compose JSEP description.
    var json = JSON.parse(xhr.responseText);
    var jsep = {
        'type': remoteSDPType(),
        'sdp': json.description,
    };

    // Set the remote peer name.
    RemoteName.innerHTML = json.name;
    quack.play();

    return new RTCSessionDescription(jsep);
}

function setRemoteDescription(description) {
    console.log('Setting remote description: ');
    console.log(description);
    return rtcPeerConnection.setRemoteDescription(description);
}

function createAnswer() {
    console.log('Creating answer...');
    return rtcPeerConnection.createAnswer(constraints.optional);
}

function sendLocalIceCandidates() {
    console.log('Sending local ICE candidates...');

    // Compose local SDP and ICE candidates JSON.
    var json = JSON.stringify({
        'ice_candidates': localIceCandidates,
    });

    return request('POST', apiUrl + '/' + localSDPType() + '?token=' + token,
        json, true);
}

function requestRemoteIceCandidates() {
    console.log('Requesting remote ICE candidates...');
    return request('GET', apiUrl + '/' + remoteSDPType() +
        '/ice_candidates?token=' + token, null, true);
}

function receiveRemoteIceCandidates(xhr) {
    console.log('Received remote ICE candidates.');
    return JSON.parse(xhr.responseText);
}

function setRemoteIceCandidates(iceCandidates) {
    console.log('Setting remote ICE candidates: ');
    console.log(iceCandidates);
    iceCandidates.forEach(iceCandidate =>
        rtcPeerConnection.addIceCandidate(iceCandidate).
        catch(errorHandler));
}

function storeLocalIceCandidate(event) {
    if (event.candidate == null) {
        console.log('Finished gathering local ICE candidates: ');
        console.log(event);
    } else {
        localIceCandidates.push(event.candidate);
        console.log(event.candidate);
    }
}

function setRemoteMediaTrack(event) {
    console.log('Received remote streams: ');
    console.log(event);
    RemoteVideo.srcObject = event.streams[0];
}

function handleMediaTrackRemoved(event) {
    console.log('Media track removal event: ');
    console.log(event);
    teardown();
}

function handleIceConnectionState(event) {
    console.log('ICE connection state changed: ');
    console.log(event);

    // Teardown the meeting if ICE has disconnected.
    if (rtcPeerConnection) {
        switch (rtcPeerConnection.iceConnectionState) {
            case "closed":
            case "failed":
            case "disconnected":
                teardown();
                break;
        }
    }
}

function handleStateChangeEvent(event) {
    console.log('ICE gathering / signaling state change event: ');
    console.log(event);
}

function handleDataChannelConnected(event) {
    console.log('DataChannel connected:');
    console.log(event);

    // Setup data channel handlers.
    dataChannel = event.channel;
    dataChannel.onmessage = function(event) {
        addMessage(RemoteName.textContent, event.data);
    }
}

function handleMessageBarTextKey(event) {
    if (event.keyCode == 13) {
        sendMessageAndData();
    }
}

function sendMessageAndData() {
    MessageBarButton.blur();
    if (dataChannel && dataChannel.readyState == 'open'
        && MessageBarText.value.length > 0) {
        addMessage(name, MessageBarText.value);
        dataChannel.send(MessageBarText.value);
        MessageBarText.value = '';
    }
}

function teardown() {
    console.log('Tearing down connection and finalizing resources...');
    deleteMiiting();
    if (rtcPeerConnection) {
        RemoteName.innerHTML += ' disconnected.';
        quack.play();
        finalize();
    }
}

function deleteMiiting() {
    // Delete the miiting on best effor basis.
    request('DELETE', apiUrl + '?token=' + token, null, true).
        then(errorHandler, errorHandler);
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
        };

        // Setup request exception handler.
        exceptionHandler = function(error) {
            reject('request failed due to timeout / network error');
            return errorHandler(error)
        };

        // Setup error & request timeout handlers.
        xhr.onerror = exceptionHandler;
        xhr.ontimeout = exceptionHandler;

        // Send our request here.
        xhr.send(body);
    });
}

function addMessage(name, message) {
    // Create new row in messages table.
    var row = Messages.insertRow(-1);

    // Create new message header cell.
    var messageHeader = document.createElement('div');
    messageHeader.className = 'MessageHeader';
    messageHeader.textContent = name;
    var messageHeaderCell = row.insertCell(0);
    messageHeaderCell.className = 'MessageHeaderCell';
    messageHeaderCell.appendChild(messageHeader);

    // Create new message text cell.
    var messageText = document.createElement('div');
    messageText.className = 'MessageText';
    messageText.textContent = message;
    var messageTextCell = row.insertCell(1);
    messageTextCell.className = 'MessageTextCell';
    messageTextCell.appendChild(messageText);

    // Scroll to bottom of table.
    Messages.scrollTop = Messages.scrollHeight;
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
}

function abortOnError(error) {
    errorHandler(error);
    return Promise.reject(error);
}

function showError(object) {
    // Display error based on object type.
    if (object instanceof XMLHttpRequest) {
        alert(JSON.parse(object.responseText).error);
    } else {
        alert(object);
    }
}

/* Below is UI-related handling */

/* The state of our messages box */
var messagesMinimized = false;

/* Toggle the maximized / minimized state of the message box. */
function toggleMessages() {
    messagesMinimized = !messagesMinimized;
    if (messagesMinimized) {
        MessagesContainer.className = 'MessagesContainerMinimized';
        ToggleMessagesButton.textContent = '█';
    } else {
        MessagesContainer.className = 'MessagesContainer';
        ToggleMessagesButton.textContent = '▁';
    }

    // Scroll to the newest bottom messages, clear focus.
    Messages.scrollTop = Messages.scrollHeight;
    ToggleMessagesButton.blur();
}

/* Author: Pu-Chen Mao (pujnmao@gmail.com)
 * For Zhe */

/* API server URL */
var href = window.location.href;
var miitingID = href.split('/').pop();
var miitingsUrl =  href.includes('miitings') ?
    href.substring(0, href.lastIndexOf('/')) :
    href.replace(miitingID, 'miitings');
var apiUrl = miitingsUrl + '/' + miitingID;

/* Our name and our peer's name to be displayed */
var localName = 'anonymous';
var remoteName = 'anonymous';

/* The token used to create and join a miiting. */
var token = generateToken();

/* Keep-alive task handle and send interval in milliseconds */
const KEEP_ALIVE_INTERVAL = 5000;
const KEEP_ALIVE_ERROR_THRESHOLD_COUNT = 3;
var keepAliveHandle;
var keepAliveErrorCount = 0;

/* Page reload timeout when disconnected. */
const PAGE_RELOAD_TIMEOUT_MS = 15 * 1000;

/* Size of a block / chunk of a file */
const CHUNK_SIZE = 4096;
const BLOCK_SIZE = 1000 * CHUNK_SIZE;
const CHUNKS_PER_BLOCK = BLOCK_SIZE / CHUNK_SIZE;

/* File datachannel buffer size & send backoff time */
const FILECHANNEL_BUFFER_SIZE = 16 * 1024 * 1024;
const FILECHANNEL_BACKOFF_MS = 1000;

/* File sequence number to track the number of files we've sent.*/
var fileCount = 0;

/* Our role in the miiting session. */
var isInitiator = true;

/* Flag indicating if our browser is capable of media functions. */
var isMediaCapable = false;

/* WebRTC variables & HTML components */
var rtcPeerConnection, messageChannel, fileChannel;
var LocalVideo, LocalName, RemoteVideo, RemoteName;
var ToggleMessagesButton, Messages, MessageBarInput;
var MessageBarFile, MessageBarButton, ClearFileSelectionButton;
var sendFileTransfers = {}, receiveFileTransfers = {}, quack;
var localIceCandidates = [], pageReloadID;

/* ICE Server Configurations */
var peerConnectionConfig = {
    'iceServers': [
        {
            'urls': [
                'stun:stun.l.google.com:19302',
                'stun:stunserver.org',
                // 'stun:stun.services.mozilla.com',
                // 'stun:stun.xten.com',
            ],
        },
    ],
    'bundlePolicy': 'balanced',
    'iceCandidatePoolSize': 5,
    'iceTransportPolicy': 'all',
    'rtcpMuxPolicy': 'require',
};

/* File transfer datachannel options. */
var fileChannelOptions = {
    'ordered': false,
    // 'maxPacketLifeTime': 10000,
    'maxRetransmits': 100,
    'negotiated': false,
};

/* Media constraints and options. */
var constraints = {
    'optional': {
        'DtlsSrtpKeyAgreement': true,
        'offerToReceiveAudio': true,
        'offerToReceiveVideo': true,
        'voiceActivityDetection': false,
    },
};

/* Codec preferences */
var preferredAudioCodec = 'opus';
var preferredVideoCodec = 'H264';

/* Video settings */
var videoSettings = {
    'width': { 'min': 160, 'ideal': 320, 'max': 640 },
    'height': { 'min': 120, 'ideal': 240, 'max': 480 },
    'frameRate': { 'min': 1, 'ideal': 30, 'max': 60 }
}

function main() {
    // Prompt user for name and save to cookies.
    localName = getCookie(miitingID + '.username');
    if (localName == null || localName.length <= 0) {
        localName = prompt('Please enter your name:', localName);
        // Stop execution if user clicked cancel.
        if (localName == null)
            return;
        document.cookie = miitingID + '.username=' + localName;
    }

    // Initialize browser Media API & DOM elements.
    initialize();

    // Set local name to user input name.
    LocalName.textContent = localName;

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
    MessageBarInput = document.getElementById('MessageBarInput');
    MessageBarFile = document.getElementById('MessageBarFile');
    MessageBarButton = document.getElementById('MessageBarButton');
    ClearFileSelectionButton = document.getElementById('ClearFileSelectionButton');

    // Initialize HTML element state & handlers.
    window.addEventListener('keypress', handleWindowKeyPress);
    RemoteName.style.visibility = 'hidden';
    LocalName.addEventListener('click', handleModifyLocalName);
    Messages.scrollTop = Messages.scrollHeight;
    MessageBarInput.addEventListener('keypress', handleMessageBarInputKey);
    MessageBarFile.addEventListener('change', handleFileSelected);
    MessageBarButton.addEventListener('click', sendMessageAndData);

    // Load notification sounds.
    quack = new Audio('/assets/quack.wav');

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
    keepAliveHandle = null;

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

    // Close messaging datachannel.
    if (messageChannel) {
        messageChannel.close();
        messageChannel = null;
    }

    // Close file transfer datachannel.
    if (fileChannel) {
        fileChannel.close();
        fileChannel = null;
    }

    // Close our RTCPeerConnection.
    if (rtcPeerConnection) {
        rtcPeerConnection.close();
        rtcPeerConnection = null;
    }
}

function run() {
    // Check if MediaDevices API is available.
    isMediaCapable = navigator.mediaDevices != null &&
        navigator.mediaDevices.enumerateDevices != null;
    if (!isMediaCapable) {
        addMessage(null, makeMessageTextDiv(
            'Error: MediaDevices API not available'));
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
        then(setupDataChannels, abortOnError).
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
    keepAliveHandle = setInterval(sendKeepAliveRequest, KEEP_ALIVE_INTERVAL);
}

function sendKeepAliveRequest() {
    request('PATCH', apiUrl + '?token=' + token, '{}', true).
        then(handleKeepAliveResponse).catch(handleKeepAliveError);
}

function handleKeepAliveResponse(xhr) {
    if (xhr.status >= 400) {
        if (++keepAliveErrorCount >= KEEP_ALIVE_ERROR_THRESHOLD_COUNT) {
            teardown();
        }
    }
}

function handleKeepAliveError(error) {
    if (++keepAliveErrorCount >= KEEP_ALIVE_ERROR_THRESHOLD_COUNT) {
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

function setupDataChannels() {
    console.log('Creating DataChannel...');

    // Create the datachannel from our peer connection.
    if (!isInitiator) {
        rtcPeerConnection.ondatachannel = handleDataChannelConnected;
    } else {
        // Setup datachannel for messaging.
        messageChannel = rtcPeerConnection.createDataChannel('message');
        messageChannel.onmessage = handleMessageChannelJSON;

        // Setup datachannel for file transfesr.
        fileChannel = rtcPeerConnection.createDataChannel(
            'file', fileChannelOptions);
        fileChannel.binaryType = 'arraybuffer';
        fileChannel.onmessage = handleFileChannelChunk;
    }
}

function enumerateMediaDevices() {
    console.log('Detecting media devices...');
    if (!isMediaCapable)
        return Promise.resolve();
    return navigator.mediaDevices.enumerateDevices();
}

function setMediaDeviceConstraints(devices) {
    console.log('Detected media devices: ');
    console.log(devices);

    // Do nothing if browser has no media capabilities.
    if (!isMediaCapable)
        return constraints;

    // Gather audio & video devices;
    var cameras = devices.filter(device => device.kind == 'videoinput');
    var microphones = devices.filter(device => device.kind == 'audioinput');

    // Set media related constraints based on available media devices.
    constraints['audio'] = microphones.length > 0;
    constraints['video'] = cameras.length > 0 ? videoSettings : false;

    console.log('Using constraints: ');
    console.log(constraints);

    return constraints;
}

function getUserMedia(constraints) {
    console.log('Initializing browser Media API...');
    if (!isMediaCapable)
        return;
    return navigator.mediaDevices.getUserMedia(constraints);
}

function setLocalMediaStream(localStream) {
    console.log('Initialized browser Media, adding tracks...');
    if (!isMediaCapable)
        return;
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

    // Do nothing if our browser has no media capabilities.
    if (!isMediaCapable)
        return description;

    // Iterate throuh all SDP lines and find media descriptions.
    var sdpLines = description.sdp.split('\r\n');
    var audioLineIndex = -1, videoLineIndex = -1, rtpmaps = {};
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
    var audioLineParts = audioLineIndex < 0 ? [] :
        sdpLines[audioLineIndex].split(' ');
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
    var videoLineParts = videoLineIndex < 0 ? [] :
        sdpLines[videoLineIndex].split(' ');
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
        'name': localName,
        'description': rtcPeerConnection.localDescription.sdp,
    };

    return request('POST', apiUrl + '?token=' + token,
        JSON.stringify(sdp), true);
}

function requestRemoteDescription() {
    console.log('Requesting remote description...');

    // Show that we are now waiting for the other end to join.
    addMessage(null, makeMessageTextDiv(
        'Waiting for peer to join...'));

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
    remoteName = json.name;
    addMessage(null, makeMessageTextDiv(remoteName + ' joined.'));
    addMessage(null, makeMessageTextDiv('Connecting with ' + remoteName + '...'));
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
    RemoteName.textContent = remoteName;
    RemoteName.style.visibility = 'visible';
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
            case 'closed':
            case 'failed':
            case 'disconnected':
                addMessage(null, makeMessageTextDiv(remoteName +
                    ' disconnected.'));
                teardown(); break;
            case 'connected':
                addMessage(null, makeMessageTextDiv('Connected with ' +
                    remoteName + '.')); break;
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

    if (event.channel.label == 'message') {
        // Setup data channel handlers for messaging.
        messageChannel = event.channel;
        messageChannel.onmessage = handleMessageChannelJSON;
    } else if (event.channel.label == 'file') {
        // Setup data channel handlers for file transfer.
        fileChannel = event.channel;
        fileChannel.binaryType = 'arraybuffer';
        fileChannel.onmessage = handleFileChannelChunk;
    }
}

function handleMessageChannelJSON(event) {
    json = JSON.parse(event.data);
    if (remoteName != json.sender) {
        addMessage(null, makeMessageTextDiv(remoteName +
            ' changed name to ' + json.sender + '.'));
        remoteName = json.sender;
        RemoteName.textContent = remoteName;
    }

    if (json.type == 'message') {
        addMessage(remoteName, makeMessageTextDiv(json.payload));
    } else if (json.type == 'fileinfo') {
        addMessage(null, makeFileTransferPromptDiv(json.payload));
        quack.play();
    } else if (json.type == 'filetransfer') {
        var response = json.payload;
        if (response.accepted) {
            handleFileTransferAccepted(response.filename);
        } else {
            handleFileTransferDeclined(response.filename);
        }
    }
}

function handleModifyLocalName(event) {
    localName = prompt('Please enter your name:', localName) || localName;
    document.cookie = miitingID + '.username=' + localName;
    LocalName.textContent = localName;
}

function handleWindowKeyPress(event) {
    MessageBarInput.focus();
}

function handleMessageBarInputKey(event) {
    if (event.keyCode == 13) {
        sendMessageAndData();
    }
}

function sendMessageAndData() {
    MessageBarButton.blur();
    if (fileChannel && fileChannel.readyState == 'open' &&
        MessageBarFile.files.length > 0) {
        var file = MessageBarFile.files[0];
        var fileID = fileCount++;
        var json = JSON.stringify({
            'sender': localName,
            'type': 'fileinfo',
            'payload': {
                'fileid': fileID,
                'filename': file.name,
                'filesize': file.size,
            },
        });

        sendFileTransfers[file.name] = {
            'file': file,
            'fileid': fileID,
            'filename': file.name,
            'filesize': file.size,
            'chunkcount': 0,
        };

        showFileTransferMessage('Prompting ' + remoteName +
            ' for file transfer of ', file.name, '...');
        messageChannel.send(json);
        clearFileSelection();

        return;
    }

    if (messageChannel && messageChannel.readyState == 'open' &&
        MessageBarInput.value.length > 0) {
        addMessage(localName, makeMessageTextDiv(
            MessageBarInput.value));
        var json = JSON.stringify({
            'sender': localName,
            'type': 'message',
            'payload': MessageBarInput.value
        });
        messageChannel.send(json);
        MessageBarInput.value = '';
        return;
    }
}

function teardown() {
    console.log('Tearing down connection and finalizing resources...');
    deleteMiiting();
    if (rtcPeerConnection) {
        RemoteName.style.visibility = 'hidden';
        pageReloadID = pageReloadID || setTimeout(function() {
            window.location.reload(true)}, PAGE_RELOAD_TIMEOUT_MS);
        showPageReloadMessage();
        quack.play();
        finalize();
    }
}

function showPageReloadMessage() {
    var reloadTimeout = PAGE_RELOAD_TIMEOUT_MS / 1000;
    var pageReloadMessageDiv = document.createElement('div');
    var cancel = document.createElement('span');
    cancel.className = 'MessagePromptLink';
    cancel.textContent = 'here';
    cancel.addEventListener('click', function(event) {
        window.clearTimeout(pageReloadID);
        addMessage(null, makeMessageTextDiv('Page reload cancelled.'));
    });
    pageReloadMessageDiv.className = 'MessageContent';
    pageReloadMessageDiv.appendChild(document.createTextNode(
        href + ' has ended, reloading in ' + reloadTimeout + ' seconds. '));
    pageReloadMessageDiv.appendChild(document.createElement('br'));
    pageReloadMessageDiv.appendChild(document.createTextNode('Click '));
    pageReloadMessageDiv.appendChild(cancel);
    pageReloadMessageDiv.appendChild(document.createTextNode(
        ' to cancel page reload.'));
    addMessage(null, pageReloadMessageDiv);
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

function addMessage(name, element) {
    // Messages without names are regarded as system messages.
    var headerClass;
    name = name || 'system';
    if (name == localName && isInitiator ||
        name == remoteName && !isInitiator) {
        headerClass = 'MessageHeaderBlue';
    } else if (name == localName && !isInitiator ||
        name == remoteName && isInitiator) {
        headerClass = 'MessageHeaderGreen';
    } else {
        headerClass = 'SystemMessageHeader';
    }

    // Create new row in messages table.
    var row = Messages.insertRow(-1);

    // Create message header div.
    var messageHeader = document.createElement('div');
    messageHeader.className = headerClass;
    messageHeader.textContent = name;
    
    // Create new message header cell.
    var messageHeaderCell = row.insertCell(0);
    messageHeaderCell.className = 'MessageHeaderCell';
    messageHeaderCell.appendChild(messageHeader);

    // Create new message text cell.
    var messageContentCell = row.insertCell(1);
    messageContentCell.className = 'MessageContentCell';
    messageContentCell.style.width = '100%';
    messageContentCell.appendChild(element);

    // Pop up message box then scroll to bottom of table.
    messagesMinimized = true;
    toggleMessages();
    Messages.scrollTop = Messages.scrollHeight;
}

function generateToken() {
    var token = '';
    var runes = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < 16; i++) {
        token += runes.charAt(Math.floor(Math.random() * runes.length));
    }
    return token;
}

function getCookie(key) {
    var value = '; ' + document.cookie;
    var parts = value.split('; ' + key + '=');
    if (parts.length >= 2)
        return parts.pop().split(';').shift();
    return '';
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
        addMessage(null, makeMessageTextDiv('Error: ' +
            JSON.parse(object.responseText).error));
    } else {
        addMessage(null, makeMessageTextDiv('Error: ' + object));
    }
}

/* Below is UI and file transfer related code, It is a mess, no MVC.
 * Clean up when you have nothing better to do with life. */

/* The state of our messages box */
var messagesMinimized = false;

function makeMessageTextDiv(message) {
    var messageTextDiv = document.createElement('div');
    messageTextDiv.className = 'MessageContent';
    messageTextDiv.textContent = message;
    return messageTextDiv;
}

function makeFileTransferPromptDiv(fileinfo) {
    var accept = document.createElement('span');
    accept.className = 'MessagePromptLink';
    accept.textContent = 'accept';
    accept.setAttribute('fileid', fileinfo['fileid']);
    accept.setAttribute('filename', fileinfo['filename']);
    accept.setAttribute('filesize', fileinfo['filesize']);
    accept.addEventListener('click', acceptFileTransfer);

    var decline = document.createElement('span');
    decline.className = 'MessagePromptLink';
    decline.textContent = 'decline';
    decline.setAttribute('fileid', fileinfo['fileID']);
    decline.setAttribute('filename', fileinfo['filename']);
    decline.setAttribute('filesize', fileinfo['filesize']);
    decline.addEventListener('click', declineFileTransfer);

    var filename = document.createElement('b');
    filename.textContent = fileinfo.filename;

    var fileTransferPromptDiv = document.createElement('div');
    fileTransferPromptDiv.className = 'MessageContent';
    fileTransferPromptDiv.appendChild(document.createTextNode(
        remoteName + ' wants to send you '));
    fileTransferPromptDiv.appendChild(filename);
    fileTransferPromptDiv.appendChild(document.createTextNode(
        ' (' + (fileinfo['filesize'] / 1024.0).toFixed(2) + ' KiB), '));
    fileTransferPromptDiv.appendChild(accept);
    fileTransferPromptDiv.appendChild(document.createTextNode(' or '));
    fileTransferPromptDiv.appendChild(decline);
    fileTransferPromptDiv.appendChild(document.createTextNode('?'));

    return fileTransferPromptDiv;
}

/* Toggle the maximized / minimized state of the message box. */
function toggleMessages() {
    messagesMinimized = !messagesMinimized;
    if (messagesMinimized) {
        MessagesContainer.className = 'MessagesContainerMinimized';
        ToggleMessagesButton.textContent = '▲';
    } else {
        MessagesContainer.className = 'MessagesContainer';
        ToggleMessagesButton.textContent = '▼';
    }

    // Scroll to the newest bottom messages, clear focus.
    Messages.scrollTop = Messages.scrollHeight;
    ToggleMessagesButton.blur();
}

function handleFileSelected() {
    MessageBarInput.className = 'MessageBarInputFile';
    MessageBarInput.value = 'File: ' + MessageBarFile.files[0].name + ' (' +
        (MessageBarFile.files[0].size / 1024.0).toFixed(2) + ' KiB)';
    MessageBarInput.readOnly = true;
    ClearFileSelectionButton.style.visibility = 'visible';
} 

function clearFileSelection() {
    MessageBarFile.value = '';
    MessageBarInput.className = 'MessageBarInputText';
    MessageBarInput.value = '';
    MessageBarInput.readOnly = false;
    ClearFileSelectionButton.style.visibility = 'hidden';
}

function acceptFileTransfer(event) {
    // Create bold filename element.
    var filename = document.createElement('b');
    filename.textContent = event.target.getAttribute('filename');

    // Clear parent node content.
    var parentNode = event.target.parentNode;
    while (parentNode.lastChild) {
        parentNode.removeChild(parentNode.lastChild);
    }

    // Set file transfer accept message.
    parentNode.appendChild(document.createTextNode(
        'Accepted file transfer of '));
    parentNode.appendChild(filename);
    parentNode.appendChild(document.createTextNode(
        ' from ' + remoteName + '.'));

    // Setup file transfer context for receiving.
    var fileID = event.target.getAttribute('fileid');
    receiveFileTransfers[fileID] = {
        'fileid': fileID,
        'filename': event.target.getAttribute('filename'),
        'filesize': event.target.getAttribute('filesize'),
        'chunks': [],
    };

    // Send file transfer accept message.
    messageChannel.send(JSON.stringify({
        'sender': localName,
        'type': 'filetransfer',
        'payload': {
            'accepted': true,
            'filename': filename.textContent,
        },
    }));

    // Show file transfer progress indication message.
    showFileTransferProgress(receiveFileTransfers[fileID]);
}

function declineFileTransfer(event) {
    // Create bold filename element.
    var filename = document.createElement('b');
    filename.textContent = event.target.getAttribute('filename');

    // Clear parent node content.
    var parentNode = event.target.parentNode;
    while (parentNode.lastChild) {
        parentNode.removeChild(parentNode.lastChild);
    }

    // Set file transfer decline message.
    parentNode.appendChild(document.createTextNode(
        'Declined file transfer of '));
    parentNode.appendChild(filename);
    parentNode.appendChild(document.createTextNode('.'));

    // Send file transfer decline message.
    messageChannel.send(JSON.stringify({
        'sender': localName,
        'type': 'filetransfer',
        'payload': {
            'accepted': false,
            'filename': filename.textContent,
        },
    }));
}

function handleFileTransferAccepted(filename) {
    var fileTransfer = sendFileTransfers[filename];
    showFileTransferMessage(remoteName +
        ' accepted file transfer of ',
        filename, ', begin sending data...');
    showFileTransferProgress(fileTransfer);
    readFileBlock(fileTransfer);
}

function handleFileTransferDeclined(filename) {
    showFileTransferMessage(remoteName +
        ' declined file transfer of ', filename, '.');
    delete sendFileTransfers[filename]['file'];
    delete sendFileTransfers[filename];
}

function readFileBlock(fileTransfer) {
    if (fileChannel.bufferedAmount + BLOCK_SIZE > FILECHANNEL_BUFFER_SIZE) {
        setTimeout(readFileBlock, FILECHANNEL_BACKOFF_MS, fileTransfer);
        return;
    }

    var blockStart = fileTransfer['chunkcount'] * CHUNK_SIZE;
    var blockEnd = Math.min(fileTransfer['filesize'],
        blockStart + BLOCK_SIZE);
    var fileReader = new FileReader();
    fileReader.onload = handleFileReaderBlock;
    fileReader.fileTransfer = fileTransfer;
    fileReader.readAsArrayBuffer(fileTransfer['file'].
        slice(blockStart, blockEnd));
}

function handleFileReaderBlock(event) {
    var fileTransfer = event.target.fileTransfer;
    var block = event.target.result;

    for (var idx = 0; idx * CHUNK_SIZE < block.byteLength; idx++) {
        var chunkOffset = idx * CHUNK_SIZE;
        var chunkLength = Math.min(CHUNK_SIZE, block.byteLength - chunkOffset);
        var chunkArray = new Uint8Array(block, chunkOffset, chunkLength);
        handleFileReaderChunk(fileTransfer, chunkArray);
    }

    var filesize = fileTransfer['filesize'];
    var totalChunks = Math.ceil(filesize / CHUNK_SIZE);
    if (fileTransfer['chunkcount'] < totalChunks) {
        readFileBlock(fileTransfer);
    } else {
        var key = fileTransfer['filename'];
        event.target.fileTransfer = null;
        handleFileSendCompleted(key, fileTransfer);
    }
}

function handleFileReaderChunk(fileTransfer, chunkArray) {
    var buffer = new ArrayBuffer(chunkArray.byteLength + 5);
    var bufferDataView = new DataView(buffer);

    new Uint8Array(buffer).set(chunkArray);
    bufferDataView.setUint8(chunkArray.byteLength,
        fileTransfer['fileid']);
    bufferDataView.setUint32(chunkArray.byteLength + 1,
        fileTransfer['chunkcount']);
    fileTransfer['chunkcount']++;

    fileChannel.send(buffer);
    updateFileSendProgress(fileTransfer);
}

function handleFileChannelChunk(event) {
    var buffer = event.data;
    var chunkDataView = new DataView(buffer);
    var fileID = chunkDataView.getUint8(
        chunkDataView.byteLength - 5);
    var chunkSeq = chunkDataView.getUint32(
        chunkDataView.byteLength - 4);
    var fileTransfer = receiveFileTransfers[fileID];
    var chunks = fileTransfer['chunks'];

    var idx = chunks.length;
    while (idx-- > 0) {
        var chunk = chunks[idx];
        var view = new DataView(chunk);
        if (view.getUint32(chunk.byteLength - 4) < chunkSeq) {
            break;
        }
    }

    chunks.splice(idx + 1, 0, buffer);
    updateFileReceptionProgress(fileTransfer);

    var filesize = fileTransfer['filesize'];
    var totalChunks = Math.ceil(filesize / CHUNK_SIZE);
    if (chunks.length >= totalChunks) {
        var key = fileTransfer['fileid'];
        handleFileReceptionCompleted(key, fileTransfer);
    }
}

function updateFileSendProgress(fileTransfer) {
    var progressBar = fileTransfer['progressbar'];
    var filesize = fileTransfer['filesize'];
    var totalChunks = Math.ceil(filesize / CHUNK_SIZE);
    var percentage = fileTransfer['chunkcount'] / totalChunks * 100;
    progressBar.setProgress(percentage);
}

function updateFileReceptionProgress(fileTransfer) {
    var progressBar = fileTransfer['progressbar'];
    var filesize = fileTransfer['filesize'];
    var totalChunks = Math.ceil(filesize / CHUNK_SIZE);
    var percentage = fileTransfer['chunks'].length / totalChunks * 100;
    progressBar.setProgress(percentage);
}

function handleFileSendCompleted(key, fileTransfer) {
    var progressBar = fileTransfer['progressbar'];
    showFileSendCompletedMessage(fileTransfer['filename'],
        progressBar.parentNode.parentNode);
    delete sendFileTransfers[key]['file'];
    delete sendFileTransfers[key];
}

function handleFileReceptionCompleted(key, fileTransfer) {
    var chunks = fileTransfer['chunks'];
    for (var idx = 0; idx < chunks.length; idx++) {
        chunks[idx] = chunks[idx].slice(0,
            chunks[idx].byteLength - 5);
    }

    var blob = new Blob(chunks);
    var link = document.createElement('a');
    var progressBar = fileTransfer['progressbar'];
    link.className = 'MessagePromptLink';
    link.href = URL.createObjectURL(blob);
    link.download = fileTransfer['filename'];
    link.textContent = fileTransfer['filename'];
    showFileReceptionCompletedMessage(link,
        progressBar.parentNode.parentNode);

    if (link.click) {
        link.click();
    } else {
        var click = document.createEvent('MouseEvents');
        click.initMouseEvent( 'click', true, true, window,
            0, 0, 0, 0, 0, false, false, false, false, 0, null);
        link.dispatchEvent(click);
    }

    delete receiveFileTransfers[key]['chunks'];
    delete receiveFileTransfers[key];
}

function showFileTransferProgress(fileTransfer) {
    var progressBarDiv = makeProgressBarDiv(fileTransfer);
    fileTransfer['progressbar'] = progressBarDiv;
    var fileTransferProgressDiv = document.createElement('div');
    fileTransferProgressDiv.className = 'FileTransferProgress';
    fileTransferProgressDiv.appendChild(progressBarDiv);
    fileTransferProgressDiv.appendChild(document.createTextNode(
        'File: ' + fileTransfer['filename'] + ' (' +
        (fileTransfer['filesize'] / 1024.0).toFixed(2) + ' KiB)'));
    addMessage(null, fileTransferProgressDiv);
}

function showFileTransferMessage(message, filename, trailing) {
    var filenameNode = document.createElement('b');
    filenameNode.textContent = filename;
    var fileTransferMessageDiv = document.createElement('div');
    fileTransferMessageDiv.className = 'MessageContent';
    fileTransferMessageDiv.appendChild(document.createTextNode(message));
    fileTransferMessageDiv.appendChild(filenameNode);
    fileTransferMessageDiv.appendChild(document.createTextNode(trailing));
    addMessage(null, fileTransferMessageDiv);
}

function showFileSendCompletedMessage(filename, parentNode) {
    while (parentNode.lastChild) {
        parentNode.removeChild(parentNode.lastChild);
    }
    var filenameNode = document.createElement('b');
    filenameNode.textContent = filename;
    parentNode.className = 'MessageContent';
    parentNode.appendChild(document.createTextNode('File transfer of '));
    parentNode.appendChild(filenameNode);
    parentNode.appendChild(document.createTextNode(' completed.'));
}

function showFileReceptionCompletedMessage(filelink, parentNode) {
    while (parentNode.lastChild) {
        parentNode.removeChild(parentNode.lastChild);
    }
    parentNode.className = 'MessageContent';
    parentNode.appendChild(document.createTextNode('File transfer of '));
    parentNode.appendChild(filelink);
    parentNode.appendChild(document.createTextNode(
        ' completed. Click to save file.'));
}

function makeProgressBarDiv(fileTransfer) {
    var progressBar = document.createElement('div');
    progressBar.className = 'FileTransferProgressBar';

    var percentageText = document.createElement('div');
    percentageText.className = 'FileTransferProgressPercentage';

    var progressBarContainer = document.createElement('div');
    progressBarContainer.className = 'FileTransferProgressBarContainer';
    progressBarContainer.appendChild(progressBar);
    progressBarContainer.appendChild(percentageText);
    progressBarContainer.setProgress = function(percentage) {
        percentageText.textContent = percentage.toFixed(2) + '%';
        progressBar.style.width = percentage.toFixed(0) + '%';
    };

    return progressBarContainer;
}

// Smoldot
// Copyright (C) 2019-2022  Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later WITH Classpath-exception-2.0

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/// <reference lib="dom" />

import { Client, ClientOptionsWithBytecode } from './public-types.js'
import { start as innerStart, Connection, ConnectionConfig } from './internals/client.js'

export {
    AddChainError,
    AddChainOptions,
    AlreadyDestroyedError,
    Chain,
    Client,
    ClientOptions,
    ClientOptionsWithBytecode,
    SmoldotBytecode,
    CrashError,
    JsonRpcDisabledError,
    QueueFullError,
    LogCallback
} from './public-types.js';

/**
 * Initializes a new client. This is a pre-requisite to connecting to a blockchain.
 *
 * Can never fail.
 *
 * @param options Configuration of the client.
 */
export function startWithBytecode(options: ClientOptionsWithBytecode): Client {
    options.forbidTcp = true;

    return innerStart(options, options.bytecode, {
        performanceNow: () => {
            return performance.now()
        },
        getRandomValues: (buffer) => {
            const crypto = globalThis.crypto;
            if (!crypto)
                throw new Error('randomness not available');

            // Browsers have this completely undocumented behavior (it's not even part of a spec)
            // that for some reason `getRandomValues` can't be called on arrayviews back by
            // `SharedArrayBuffer`s and they throw an exception if you try.
            if (buffer.buffer instanceof ArrayBuffer)
                crypto.getRandomValues(buffer);
            else {
                const tmpArray = new Uint8Array(buffer.length);
                crypto.getRandomValues(tmpArray);
                buffer.set(tmpArray);
            }
        },
        connect: (config) => {
            return connect(config)
        }
    })
}

/**
 * Tries to open a new connection using the given configuration.
 *
 * @see Connection
 * @throws any If the multiaddress couldn't be parsed or contains an invalid protocol.
 */
function connect(config: ConnectionConfig): Connection {
    if (config.address.ty === "websocket") {
        // Even though the WHATWG specification (<https://websockets.spec.whatwg.org/#dom-websocket-websocket>)
        // doesn't mention it, `new WebSocket` can throw an exception if the URL is forbidden
        // for security reasons. We absord this exception as soon as it is thrown.
        // `connection` can be either a `WebSocket` object (the normal case), or a string
        // indicating an error message that must be propagated with `onConnectionReset` as soon
        // as possible, or `null` if the API user considers the connection as reset.
        let connection: WebSocket | string | null;
        try {
            connection = new WebSocket(config.address.url);
        } catch (error) {
            connection = error instanceof Error ? error.toString() : "Exception thrown by new WebSocket";
        }

        const bufferedAmountCheck = { quenedUnreportedBytes: 0, nextTimeout: 10 };
        const checkBufferedAmount = () => {
            if (!(connection instanceof WebSocket))
                return;
            if (connection.readyState != 1)
                return;
            // Note that we might expect `bufferedAmount` to always be <= the sum of the lengths
            // of all the data that has been sent, but that might not be the case. For this
            // reason, we use `bufferedAmount` as a hint rather than a correct value.
            const bufferedAmount = connection.bufferedAmount;
            let wasSent = bufferedAmountCheck.quenedUnreportedBytes - bufferedAmount;
            if (wasSent < 0) wasSent = 0;
            bufferedAmountCheck.quenedUnreportedBytes -= wasSent;
            if (bufferedAmountCheck.quenedUnreportedBytes != 0) {
                setTimeout(checkBufferedAmount, bufferedAmountCheck.nextTimeout);
                bufferedAmountCheck.nextTimeout *= 2;
                if (bufferedAmountCheck.nextTimeout > 500)
                    bufferedAmountCheck.nextTimeout = 500;
            }
            // Note: it is important to call `onWritableBytes` at the very end, as it might
            // trigger a call to `send`.
            if (wasSent != 0)
                config.onWritableBytes(wasSent);
        };

        if (connection instanceof WebSocket) {
            connection.binaryType = 'arraybuffer';

            connection.onopen = () => {
                config.onWritableBytes(1024 * 1024);
            };
            connection.onclose = (event) => {
                const message = "Error code " + event.code + (!!event.reason ? (": " + event.reason) : "");
                config.onConnectionReset(message);
            };
            connection.onmessage = (msg) => {
                config.onMessage(new Uint8Array(msg.data as ArrayBuffer));
            };
        } else {
            setTimeout(() => {
                if (connection && !(connection instanceof WebSocket)) {
                    config.onConnectionReset(connection);
                    connection = null;
                }
            }, 1)
        }

        return {
            reset: (): void => {
                if (connection instanceof WebSocket) {
                    connection.onopen = null;
                    connection.onclose = null;
                    connection.onmessage = null;
                    connection.onerror = null;

                    // According to the WebSocket specification, calling `close()` when a WebSocket
                    // isn't fully opened yet is completely legal and seemingly a normal thing to
                    // do (see <https://websockets.spec.whatwg.org/#dom-websocket-close>).
                    // Unfortunately, browsers print a warning in the console if you do that. To
                    // avoid these warnings, we only call `close()` if the connection is fully
                    // opened. According to <https://websockets.spec.whatwg.org/#garbage-collection>,
                    // removing all the event listeners will cause the WebSocket to be garbage
                    // collected, which should have the same effect as `close()`.
                    if (connection.readyState == WebSocket.OPEN)
                        connection.close();
                }

                connection = null;
            },

            send: (data: Uint8Array): void => {
                (connection as WebSocket).send(data);
                if (bufferedAmountCheck.quenedUnreportedBytes == 0) {
                    bufferedAmountCheck.nextTimeout = 10;
                    setTimeout(checkBufferedAmount, 10);
                }
                bufferedAmountCheck.quenedUnreportedBytes += data.length;
            },

            closeSend: (): void => { throw new Error('Wrong connection type') },
            openOutSubstream: () => { throw new Error('Wrong connection type') }
        };
    } else if (config.address.ty === "webrtc") {
        const { targetPort, ipVersion, targetIp, remoteTlsCertificateSha256 } =
            config.address;

        // TODO: detect localhost for Firefox? https://bugzilla.mozilla.org/show_bug.cgi?id=1659672

        // Note that `pc` can be the connection, but also null or undefined.
        // `undefined` means "certificate generation in progress", while `null` means "opening must
        // be cancelled".
        // While it would be better to use for example a string instead of `null`, using `null` lets
        // us use the `!` operator more easily and leads to more readable code.
        let pc: RTCPeerConnection | null | undefined = undefined;
        // Contains the data channels that are open and have been reported to smoldot.
        const dataChannels = new Map<number, { channel: RTCDataChannel, bufferedBytes: number }>();
        // SHA256 hash of the DTLS certificate of the local node. Unknown as long as it hasn't been
        // generated.
        // TODO: could be merged with `pc` in one variable, and maybe even the other fields as well
        let localTlsCertificateSha256: Uint8Array | undefined;

        // Kills all the JavaScript objects (the connection and all its substreams), ensuring that no
        // callback will be called again. Doesn't report anything to smoldot, as this should be done
        // by the caller.
        const killAllJs = () => {
            // The `RTCPeerConnection` is created pretty quickly. It is however still possible for
            // smoldot to cancel the opening, in which case `pc` will still be undefined.
            if (!pc) {
                console.assert(dataChannels.size === 0, "substreams exist while pc is undef")
                pc = null;
                return
            }

            pc!.onconnectionstatechange = null;
            pc!.onnegotiationneeded = null;
            pc!.ondatachannel = null;

            for (const channel of Array.from(dataChannels.values())) {
                channel.channel.onopen = null;
                channel.channel.onerror = null;
                channel.channel.onclose = null;
                channel.channel.onbufferedamountlow = null;
                channel.channel.onmessage = null;
            }
            dataChannels.clear();

            pc!.close();  // Not necessarily necessary, but it doesn't hurt to do so.
        };

        // Function that configures a newly-opened channel and adds it to the map. Used for both
        // inbound and outbound substreams.
        const addChannel = (dataChannel: RTCDataChannel, direction: 'inbound' | 'outbound') => {
            const dataChannelId = dataChannel.id!;
            dataChannel.binaryType = 'arraybuffer';

            let isOpen = { value: false };

            dataChannel.onopen = () => {
                console.assert(!isOpen.value, "substream opened twice")
                isOpen.value = true;
                config.onStreamOpened(dataChannelId, direction);
                config.onWritableBytes(65536, dataChannelId);
            };

            dataChannel.onerror = dataChannel.onclose = (_error) => {
                if (!isOpen.value) {
                    // Substream wasn't opened yet and thus has failed to open. The API has no
                    // mechanism to report substream openings failures. We could try opening it
                    // again, but given that it's unlikely to succeed, we simply opt to kill the
                    // entire connection.
                    killAllJs();
                    // Note that the event doesn't give any additional reason for the failure.
                    config.onConnectionReset("data channel failed to open");
                } else {
                    // Substream was open and is now closed. Normal situation.
                    config.onStreamReset(dataChannelId);
                }
            };

            dataChannel.onbufferedamountlow = () => {
                const channel = dataChannels.get(dataChannelId)!;
                const val = channel.bufferedBytes;
                channel.bufferedBytes = 0;
                config.onWritableBytes(val, dataChannelId);
            };

            dataChannel.onmessage = (m) => {
                // The `data` field is an `ArrayBuffer`.
                config.onMessage(new Uint8Array(m.data), dataChannelId);
            }

            dataChannels.set(dataChannelId, { channel: dataChannel, bufferedBytes: 0 });
        }

        // It is possible for the browser to use multiple different certificates.
        // In order for our local certificate to be deterministic, we need to generate it manually and
        // set it explicitly as part of the configuration.
        // According to <https://w3c.github.io/webrtc-pc/#dom-rtcpeerconnection-generatecertificate>,
        // browsers are guaranteed to support `{ name: "ECDSA", namedCurve: "P-256" }`.
        RTCPeerConnection.generateCertificate({ name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as EcKeyGenParams).then(async (localCertificate) => {
            if (pc === null)
                return;

            // Create a new WebRTC connection.
            pc = new RTCPeerConnection({ certificates: [localCertificate] });

            // We need to build the multihash corresponding to the local certificate.
            // While there exists a `RTCPeerConnection.getFingerprints` function, Firefox notably
            // doesn't support it.
            // See <https://developer.mozilla.org/en-US/docs/Web/API/RTCCertificate#browser_compatibility>
            // An alternative to `getFingerprints` is to ask the browser to generate an SDP offer and
            // extract from fingerprint from it. Because we explicitly provide a certificate, we have
            // the guarantee that the list of certificates will always be the same whenever an SDP offer
            // is generated by the browser. However, while this alternative does work on Firefox, it
            // doesn't on Chrome, as the SDP offer is for some reason missing the fingerprints.
            // Therefore, our strategy is to use `getFingerprints` when it is available (i.e. every
            // browser except Firefox), and parse the SDP offer when it is not (i.e. Firefox). In the
            // future, only `getFingerprints` would be used.
            let localTlsCertificateHex: string | undefined;
            if (localCertificate.getFingerprints as any) {
                for (const { algorithm, value } of localCertificate.getFingerprints()) {
                    if (algorithm === 'sha-256') {
                        localTlsCertificateHex = value!
                        break;
                    }
                }
            } else {
                const localSdpOffer = await pc.createOffer();
                // Note that this regex is not strict. The browser isn't a malicious actor, and the
                // objective of this regex is not to detect invalid input.
                const localSdpOfferFingerprintMatch = localSdpOffer.sdp!.match(/a(\s*)=(\s*)fingerprint:(\s*)(sha|SHA)-256(\s*)(([a-fA-F0-9]{2}(:)*){32})/);
                if (localSdpOfferFingerprintMatch) {
                    localTlsCertificateHex = localSdpOfferFingerprintMatch[6]!;
                }
            }
            if (localTlsCertificateHex === undefined) {
                // Because we've already returned from the `connect` function at this point, we pretend
                // that the connection has failed to open.
                config.onConnectionReset('Failed to obtain the browser certificate fingerprint');
                return;
            }
            localTlsCertificateSha256 = new Uint8Array(32);
            localTlsCertificateSha256.set(localTlsCertificateHex!.split(':').map((s) => parseInt(s, 16)), 0);

            // `onconnectionstatechange` is used to detect when the connection has closed or has failed
            // to open.
            // Note that smoldot will think that the connection is open even when it is still opening.
            // Therefore we don't care about events concerning the fact that the connection is now fully
            // open.
            pc.onconnectionstatechange = (_event) => {
                if (pc!.connectionState == "closed" || pc!.connectionState == "disconnected" || pc!.connectionState == "failed") {
                    killAllJs();
                    config.onConnectionReset("WebRTC state transitioned to " + pc!.connectionState);
                }
            };

            pc.onnegotiationneeded = async (_event) => {
                // Create a new offer and set it as local description.
                let sdpOffer = (await pc!.createOffer()).sdp!;
                // We check that the locally-generated SDP offer has a data channel with the UDP
                // protocol. If that isn't the case, the connection will likely fail.
                if (sdpOffer.match(/^m=application(\s+)(\d+)(\s+)UDP\/DTLS\/SCTP(\s+)webrtc-datachannel$/m) === null) {
                    console.error("Local offer doesn't contain UDP data channel. WebRTC connections will likely fail. Please report this issue.");
                }
                // According to the libp2p WebRTC spec, the ufrag and pwd are the same
                // randomly-generated string on both sides, and must be prefixed with
                // `libp2p-webrtc-v1:`. We modify the local description to ensure that.
                // While we could randomly generate a new string, we just grab the one that the
                // browser has generated, in order to make sure that it respects the constraints
                // of the ICE protocol.
                const browserGeneratedPwd = sdpOffer.match(/^a=ice-pwd:(.+)$/m)?.at(1);
                if (browserGeneratedPwd === undefined) {
                    console.error("Failed to set ufrag to pwd. WebRTC connections will likely fail. Please report this issue.");
                }
                const ufragPwd = "libp2p+webrtc+v1/" + browserGeneratedPwd;
                sdpOffer = sdpOffer.replace(/^a=ice-ufrag.*$/m, 'a=ice-ufrag:' + ufragPwd);
                sdpOffer = sdpOffer.replace(/^a=ice-pwd.*$/m, 'a=ice-pwd:' + ufragPwd);
                await pc!.setLocalDescription({ type: 'offer', sdp: sdpOffer });

                // Transform certificate hash into fingerprint (upper-hex; each byte separated by ":").
                const fingerprint = Array.from(remoteTlsCertificateSha256).map((n) => ("0" + n.toString(16)).slice(-2).toUpperCase()).join(':');

                // Note that the trailing line feed is important, as otherwise Chrome
                // fails to parse the payload.
                const remoteSdp =
                    // Version of the SDP protocol. Always 0. (RFC8866)
                    "v=0" + "\n" +
                    // Identifies the creator of the SDP document. We are allowed to use dummy values
                    // (`-` and `0.0.0.0`) to remain anonymous, which we do. Note that "IN" means
                    // "Internet" (and not "input"). (RFC8866)
                    "o=- 0 0 IN IP" + ipVersion + " " + targetIp + "\n" +
                    // Name for the session. We are allowed to pass a dummy `-`. (RFC8866)
                    "s=-" + "\n" +
                    // Start and end of the validity of the session. `0 0` means that the session never
                    // expires. (RFC8866)
                    "t=0 0" + "\n" +
                    // A lite implementation is only appropriate for devices that will
                    // always be connected to the public Internet and have a public
                    // IP address at which it can receive packets from any
                    // correspondent.  ICE will not function when a lite implementation
                    // is placed behind a NAT (RFC8445).
                    "a=ice-lite" + "\n" +
                    // A `m=` line describes a request to establish a certain protocol.
                    // The protocol in this line (i.e. `TCP/DTLS/SCTP` or `UDP/DTLS/SCTP`) must always be
                    // the same as the one in the offer. We know that this is true because checked above.
                    // The `<fmt>` component must always be `webrtc-datachannel` for WebRTC.
                    // The rest of the SDP payload adds attributes to this specific media stream.
                    // RFCs: 8839, 8866, 8841
                    "m=application " + String(targetPort) + " " + "UDP/DTLS/SCTP webrtc-datachannel" + "\n" +
                    // Indicates the IP address of the remote.
                    // Note that "IN" means "Internet" (and not "input").
                    "c=IN IP" + ipVersion + " " + targetIp + "\n" +
                    // Media ID - uniquely identifies this media stream (RFC9143).
                    "a=mid:0" + "\n" +
                    // Indicates that we are complying with RFC8839 (as oppposed to the legacy RFC5245).
                    "a=ice-options:ice2" + "\n" +
                    // ICE username and password, which are used for establishing and
                    // maintaining the ICE connection. (RFC8839)
                    // These values are set according to the libp2p WebRTC specification.
                    "a=ice-ufrag:" + ufragPwd + "\n" +
                    "a=ice-pwd:" + ufragPwd + "\n" +
                    // Fingerprint of the certificate that the server will use during the TLS
                    // handshake. (RFC8122)
                    // MUST be derived from the certificate used by the answerer (server).
                    "a=fingerprint:sha-256 " + fingerprint + "\n" +
                    // Indicates that the remote DTLS server will only listen for incoming
                    // connections. (RFC5763)
                    // The answerer (server) MUST not be located behind a NAT (RFC6135).
                    "a=setup:passive" + "\n" +
                    // The SCTP port (RFC8841)
                    // Note it's different from the "m=" line port value, which
                    // indicates the port of the underlying transport-layer protocol
                    // (UDP or TCP)
                    "a=sctp-port:5000" + "\n" +
                    // The maximum SCTP user message size (in bytes) (RFC8841)
                    // Setting this field is part of the libp2p spec.
                    "a=max-message-size:16384" + "\n" +
                    // A transport address for a candidate that can be used for connectivity
                    // checks (RFC8839).
                    "a=candidate:1 1 UDP 1 " + targetIp + " " + String(targetPort) + " typ host" + "\n";

                await pc!.setRemoteDescription({ type: "answer", sdp: remoteSdp });
            };

            pc.ondatachannel = ({ channel }) => {
                // TODO: is the substream maybe already open? according to the Internet it seems that no but it's unclear
                addChannel(channel, 'inbound')
            };

            config.onMultistreamHandshakeInfo({
                handshake: 'webrtc',
                localTlsCertificateSha256,
            });
        });

        return {
            reset: (streamId: number | undefined): void => {
                // If `streamId` is undefined, then the whole connection must be destroyed.
                if (streamId === undefined) {
                    killAllJs();

                } else {
                    const channel = dataChannels.get(streamId)!;
                    channel.channel.onopen = null;
                    channel.channel.onerror = null;
                    channel.channel.onclose = null;
                    channel.channel.onbufferedamountlow = null;
                    channel.channel.onmessage = null;
                    channel.channel.close();
                    dataChannels.delete(streamId);
                }
            },

            send: (data: Uint8Array, streamId: number): void => {
                const channel = dataChannels.get(streamId)!;
                channel.channel.send(data);
                channel.bufferedBytes += data.length;
            },

            closeSend: (): void => { throw new Error('Wrong connection type') },

            openOutSubstream: () => {
                // `openOutSubstream` can only be called after we have called `config.onOpen`,
                // therefore `pc` is guaranteed to be non-null.
                // Note that the label passed to `createDataChannel` is required to be empty as
                // per the libp2p WebRTC specification.
                addChannel(pc!.createDataChannel(""), 'outbound')
            }
        };

    } else {
        // Should never happen, as we tweak the options to refuse connection types that
        // we don't support.
        throw new Error();
    }
}

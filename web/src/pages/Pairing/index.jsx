import React, { useEffect, useState } from "react";
import "./styles/main.css";
import { useSocketContext } from "context/socketContext";

const Pairing = () => {
	const api = useSocketContext();
	const [qrData, setQrData] = useState(null);
	const [status, setStatus] = useState('loading');

	useEffect(() => {
		const checkStatus = async () => {
			try {
				const res = await fetch(`${api.baseUrl}/api/status`);
				const data = await res.json();
				if (data.ok) {
					setStatus(data.result.phase);
				}
			} catch (err) {
				setStatus('error');
			}
		};

		const fetchQR = async () => {
			try {
				const res = await fetch(`${api.baseUrl}/api/qr`);
				const data = await res.json();
				if (data.ok && data.result) {
					setQrData(data.result);
				}
			} catch (err) {
				console.error('Failed to fetch QR:', err);
			}
		};

		checkStatus();
		fetchQR();

		// Poll for status and QR updates
		const interval = setInterval(() => {
			checkStatus();
			fetchQR();
		}, 3000);

		return () => clearInterval(interval);
	}, [api.baseUrl]);

	// If ready, this component shouldn't be shown
	if (status === 'ready') {
		return null;
	}

	return (
		<div className="pairing">
			<div className="pairing__container">
				<h1 className="pairing__title">WhatsApp Web</h1>
				
				<div className="pairing__steps">
					<p className="pairing__step">1. Open WhatsApp on your phone</p>
					<p className="pairing__step">2. Tap <strong>Menu</strong> or <strong>Settings</strong> and select <strong>Linked Devices</strong></p>
					<p className="pairing__step">3. Tap on <strong>Link a Device</strong></p>
					<p className="pairing__step">4. Point your phone at this screen to capture the QR code</p>
				</div>

				<div className="pairing__qr-wrapper">
					{qrData ? (
						<img 
							src={qrData.dataUrl || `${api.baseUrl}/api/qr/image`} 
							alt="QR Code" 
							className="pairing__qr"
						/>
					) : (
						<div className="pairing__qr-loading">
							<div className="pairing__spinner"></div>
							<p>Loading QR Code...</p>
						</div>
					)}
				</div>

				{status === 'error' && (
					<p className="pairing__error">
						Unable to connect to WhatsApp daemon. Make sure it's running.
					</p>
				)}
			</div>
		</div>
	);
};

export default Pairing;

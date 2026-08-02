import React, { useEffect, useMemo, useState } from "react";
import "./styles/main.css";
import { useSocketContext } from "context/socketContext";

const Pairing = () => {
	const api = useSocketContext();
	const [qrData, setQrData] = useState(null);
	const [status, setStatus] = useState("loading");

	useEffect(() => {
		let cancelled = false;

		const checkStatus = async () => {
			try {
				const data = await api.fetchStatus();
				if (!cancelled && data.ok) {
					setStatus(data.result.phase);
				}
			} catch (err) {
				if (!cancelled) setStatus("error");
			}
		};

		const fetchQR = async () => {
			try {
				const data = await api.fetchQr();
				if (!cancelled && data.ok && data.result) {
					setQrData(data.result);
				}
			} catch (err) {
				console.error("Failed to fetch QR:", err);
			}
		};

		checkStatus();
		fetchQR();

		const interval = setInterval(() => {
			checkStatus();
			fetchQR();
		}, 3000);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [api, api.account]);

	const accountOptions = useMemo(
		() => api.accounts || [],
		[api.accounts],
	);

	// If ready, this component shouldn't be shown
	if (status === "ready") {
		return null;
	}

	return (
		<div className="pairing">
			<div className="pairing__container">
				<h1 className="pairing__title">WhatsApp Web</h1>

				{accountOptions.length > 1 && (
					<div className="pairing__account-switch">
						<label htmlFor="pairing-account">Account</label>
						<select
							id="pairing-account"
							value={api.account}
							onChange={(e) => {
								const next = e.target.value;
								api.setAccount(next);
								window.location.assign(`/?account=${encodeURIComponent(next)}`);
							}}
						>
							{accountOptions.map((entry) => (
								<option key={entry.id} value={entry.id}>
									{(entry.description || entry.alias || entry.id)
										+ (entry.ready ? " · ready" : ` · ${entry.phase || "offline"}`)}
								</option>
							))}
						</select>
					</div>
				)}

				<div className="pairing__steps">
					<p className="pairing__step">1. Open WhatsApp on your phone</p>
					<p className="pairing__step">2. Tap <strong>Menu</strong> or <strong>Settings</strong> and select <strong>Linked Devices</strong></p>
					<p className="pairing__step">3. Tap on <strong>Link a Device</strong></p>
					<p className="pairing__step">4. Point your phone at this screen to capture the QR code</p>
				</div>

				<div className="pairing__qr-wrapper">
					{qrData ? (
						<img
							src={qrData.dataUrl || api.mediaUrl("/api/qr/image")}
							alt="QR Code"
							className="pairing__qr"
						/>
					) : (
						<div className="pairing__qr-loading">
							<div className="pairing__spinner"></div>
							<p>Loading QR Code for {api.account}...</p>
						</div>
					)}
				</div>

				{status === "error" && (
					<p className="pairing__error">
						Unable to connect to WhatsApp daemon. Make sure it's running.
					</p>
				)}
			</div>
		</div>
	);
};

export default Pairing;

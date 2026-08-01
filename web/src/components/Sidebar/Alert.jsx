import React, { useEffect, useState } from "react";
import Icon from "components/Icon";
import { useSocketContext } from "context/socketContext";

const Alert = () => {
	const api = useSocketContext();
	const [status, setStatus] = useState({ phase: 'loading', ready: false });

	useEffect(() => {
		const checkStatus = async () => {
			try {
				const res = await fetch(`${api.baseUrl}/api/status`);
				const data = await res.json();
				if (data.ok) {
					setStatus(data.result);
				}
			} catch (err) {
				setStatus({ phase: 'error', ready: false });
			}
		};
		checkStatus();
		// Poll every 5 seconds
		const interval = setInterval(checkStatus, 5000);
		return () => clearInterval(interval);
	}, [api.baseUrl]);

	// Don't show alert if connected
	if (status.ready && status.connectionState === 'CONNECTED') {
		return null;
	}

	// Show pairing QR alert
	if (status.phase === 'pairing') {
		return (
			<div className="sidebar__alert sidebar__alert--info">
				<div className="sidebar__alert-icon-wrapper">
					<Icon id="notification" className="sidebar__alert-icon" />
				</div>
				<div className="sidebar__alert-texts">
					<p className="sidebar__alert-text">Scan QR Code</p>
					<p className="sidebar__alert-text">
						Open WhatsApp on your phone to link this device.
					</p>
				</div>
			</div>
		);
	}

	// Show disconnected warning
	if (status.phase === 'error' || !status.ready) {
		return (
			<div className="sidebar__alert sidebar__alert--warning">
				<div className="sidebar__alert-icon-wrapper">
					<Icon id="noWifi" className="sidebar__alert-icon" />
				</div>
				<div className="sidebar__alert-texts">
					<p className="sidebar__alert-text">Phone Not Connected</p>
					<p className="sidebar__alert-text">
						Make sure your phone has an active internet connection.{" "}
						<a
							className="underline"
							href="https://faq.whatsapp.com/web/troubleshooting/cant-connect-to-whatsapp-web-or-desktop/"
							target="_blank"
							rel="noreferrer"
						>
							Learn more.
						</a>
					</p>
				</div>
			</div>
		);
	}

	return null;
};

export default Alert;

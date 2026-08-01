import Icon from "components/Icon";
import React from "react";
import formatTime from "utils/formatTime";

const API_URL = "http://localhost:5001";

const Convo = ({ lastMsgRef, messages: allMessages }) => {
	const dates = Object.keys(allMessages);

	const renderMedia = (message, assignRef) => {
		const isReceived = message.sender;
		const mediaUrl = message.mediaUrl ? `${API_URL}${message.mediaUrl}` : null;
		
		// Sticker
		if (message.type === 'sticker' && mediaUrl) {
			return (
				<div
					className={`chat__msg chat__sticker-wrapper ${
						isReceived ? "chat__msg--rxd" : "chat__msg--sent"
					}`}
					ref={assignRef()}
				>
					<img src={mediaUrl} alt="Sticker" className="chat__sticker" />
					<span className="chat__msg-footer">
						<span>{formatTime(message.time)}</span>
						{!isReceived && (
							<Icon
								id={message?.status === "sent" ? "singleTick" : "doubleTick"}
								aria-label={message?.status}
								className={`chat__msg-status-icon ${
									message?.status === "read" ? "chat__msg-status-icon--blue" : ""
								}`}
							/>
						)}
					</span>
				</div>
			);
		}
		
		// Image
		if ((message.type === 'image' || message.type === 'ptt' || message.type === 'audio' || message.type === 'video' || message.type === 'document') && mediaUrl) {
			return (
				<div
					className={`chat__msg chat__img-wrapper ${
						isReceived ? "chat__msg--rxd" : "chat__msg--sent"
					}`}
					ref={assignRef()}
				>
					{message.type === 'image' ? (
						<img src={mediaUrl} alt="" className="chat__img" />
					) : message.type === 'video' ? (
						<video src={mediaUrl} controls className="chat__video" />
					) : message.type === 'ptt' || message.type === 'audio' ? (
						<audio src={mediaUrl} controls className="chat__audio" />
					) : (
						<a href={mediaUrl} target="_blank" rel="noreferrer" className="chat__document">
							📎 {message.content || 'Document'}
						</a>
					)}
					{message.content && <p className="chat__img-caption">{message.content}</p>}
					<span className="chat__msg-footer">
						<span>{formatTime(message.time)}</span>
						{!isReceived && (
							<Icon
								id={message?.status === "sent" ? "singleTick" : "doubleTick"}
								aria-label={message?.status}
								className={`chat__msg-status-icon ${
									message?.status === "read" ? "chat__msg-status-icon--blue" : ""
								}`}
							/>
						)}
					</span>
					<button aria-label="Message options" className="chat__msg-options">
						<Icon id="downArrow" className="chat__msg-options-icon" />
					</button>
				</div>
			);
		}
		
		return null;
	};

	return dates.map((date, dateIndex) => {
		const messages = allMessages[date];
		return (
			<div key={dateIndex}>
				<div className="chat__date-wrapper">
					<span className="chat__date"> {date}</span>
				</div>
				{dateIndex === 0 && (
					<p className="chat__encryption-msg">
						<Icon id="lock" className="chat__encryption-icon" />
						Messages are end-to-end encrypted. No one outside of this chat, not
						even WhatsApp, can read or listen to them. Click to learn more.
					</p>
				)}
				<div className="chat__msg-group">
					{messages.map((message, msgIndex) => {
						const assignRef = () =>
							dateIndex === dates.length - 1 && msgIndex === messages.length - 1
								? lastMsgRef
								: undefined;
						
						// Handle media messages (sticker, image, video, audio, document)
						if (message.hasMedia || message.type === 'sticker' || message.type === 'image' || message.type === 'video' || message.type === 'ptt' || message.type === 'audio' || message.type === 'document') {
							const mediaElement = renderMedia(message, assignRef);
							if (mediaElement) return <React.Fragment key={message.id || msgIndex}>{mediaElement}</React.Fragment>;
						}
						
						// Regular text message
						return (
							<React.Fragment key={message.id || msgIndex}>
								{message.sender ? (
									<p className="chat__msg chat__msg--rxd" ref={assignRef()}>
										<span>{message.content}</span>
										<span className="chat__msg-filler"> </span>
										<span className="chat__msg-footer">
											{formatTime(message.time)}
										</span>
										<button
											aria-label="Message options"
											className="chat__msg-options"
										>
											<Icon id="downArrow" className="chat__msg-options-icon" />
										</button>
									</p>
								) : (
									<p className="chat__msg chat__msg--sent" ref={assignRef()}>
										<span>{message.content}</span>
										<span className="chat__msg-filler"> </span>
										<span className="chat__msg-footer">
											<span> {formatTime(message.time)} </span>
											<Icon
												id={
													message?.status === "sent"
														? "singleTick"
														: "doubleTick"
												}
												aria-label={message?.status}
												className={`chat__msg-status-icon ${
													message?.status === "read"
														? "chat__msg-status-icon--blue"
														: ""
												}`}
											/>
										</span>
										<button
											aria-label="Message options"
											className="chat__msg-options"
										>
											<Icon id="downArrow" className="chat__msg-options-icon" />
										</button>
									</p>
								)}
							</React.Fragment>
						);
					})}
				</div>
			</div>
		);
	});
};

export default Convo;

import React from "react";
import Icon from "components/Icon";
import { Link } from "react-router-dom";
import formatTime from "utils/formatTime";
import { useUsersContext } from "context/usersContext";

const Contact = ({ contact }) => {
	const { setUserAsUnread } = useUsersContext();
	const getLastMessage = () => {
		if (!contact.messages) return { content: contact.lastMessage || '', time: '', status: null };
		const messageDates = Object.keys(contact.messages);
		if (messageDates.length === 0) return { content: contact.lastMessage || '', time: '', status: null };
		const recentMessageDate = messageDates[messageDates.length - 1];
		const messages = [...(contact.messages[recentMessageDate] || [])];
		if (messages.length === 0) return { content: contact.lastMessage || '', time: '', status: null };
		const lastMessage = messages.pop();
		return lastMessage;
	};

	const lastMessage = getLastMessage(contact);
	
	// Default avatar for contacts without profile picture
	const avatarUrl = contact.profile_picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(contact.name || '?')}&background=25D366&color=fff`;

	return (
		<Link
			className="sidebar-contact"
			to={`/chat/${encodeURIComponent(contact.id)}`}
			onClick={() => setUserAsUnread(contact.id)}
		>
			<div className="sidebar-contact__avatar-wrapper">
				<img
					src={avatarUrl}
					alt={contact.name}
					className="avatar"
				/>
			</div>
			<div className="sidebar-contact__content">
				<div className="sidebar-contact__top-content">
					<h2 className="sidebar-contact__name"> {contact.name} </h2>
					<span className="sidebar-contact__time">
						{lastMessage?.time ? formatTime(lastMessage.time) : ''}
					</span>
				</div>
				<div className="sidebar-contact__bottom-content">
					<p className="sidebar-contact__message-wrapper">
						{lastMessage?.status && (
							<Icon
								id={
									lastMessage?.status === "sent" ? "singleTick" : "doubleTick"
								}
								aria-label={lastMessage?.status}
								className={`sidebar-contact__message-icon ${
									lastMessage?.status === "read"
										? "sidebar-contact__message-icon--blue"
										: ""
								}`}
							/>
						)}
						<span
							className={`sidebar-contact__message ${
								!!contact.unread ? "sidebar-contact__message--unread" : ""
							}`}
						>
							{contact.typing ? <i> typing...</i> : lastMessage?.content || ''}
						</span>
					</p>
					<div className="sidebar-contact__icons">
						{contact.pinned && (
							<Icon id="pinned" className="sidebar-contact__icon" />
						)}
						{!!contact.unread && (
							<span className="sidebar-contact__unread">{contact.unread}</span>
						)}
						<button aria-label="sidebar-contact__btn">
							<Icon
								id="downArrow"
								className="sidebar-contact__icon sidebar-contact__icon--dropdown"
							/>
						</button>
					</div>
				</div>
			</div>
		</Link>
	);
};

export default Contact;

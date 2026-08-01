import React, { useEffect, useState } from "react";
import "./styles/main.css";
import defaultAvatar from "assets/images/profile-picture-girl-1.jpeg";
import Icon from "components/Icon";
import Alert from "./Alert";
import Contact from "./Contact";
import OptionsBtn from "components/OptionsButton";
import { useUsersContext } from "context/usersContext";
import { useSocketContext } from "context/socketContext";

const Sidebar = () => {
	const { users: contacts } = useUsersContext();
	const api = useSocketContext();
	const [me, setMe] = useState({ pushname: 'Loading...', phone: '' });
	const [searchQuery, setSearchQuery] = useState('');

	useEffect(() => {
		const fetchMe = async () => {
			try {
				const res = await fetch(`${api.baseUrl}/api/me`);
				const data = await res.json();
				if (data.ok && data.result) {
					setMe(data.result);
				}
			} catch (err) {
				console.error('Failed to fetch user info:', err);
			}
		};
		fetchMe();
	}, [api.baseUrl]);

	// Filter contacts by search query
	const filteredContacts = contacts.filter(contact => {
		if (!searchQuery.trim()) return true;
		const query = searchQuery.toLowerCase();
		const name = (contact.name || '').toLowerCase();
		const phone = (contact.phone_number || '').toLowerCase();
		return name.includes(query) || phone.includes(query);
	});

	return (
		<aside className="sidebar">
			<header className="header">
				<div className="sidebar__avatar-wrapper">
					<img src={defaultAvatar} alt={me.pushname || 'Me'} className="avatar" />
				</div>
				<div className="sidebar__actions">
					<button className="sidebar__action" aria-label="Status">
						<Icon
							id="status"
							className="sidebar__action-icon sidebar__action-icon--status"
						/>
					</button>
					<button className="sidebar__action" aria-label="New chat">
						<Icon id="chat" className="sidebar__action-icon" />
					</button>
					<OptionsBtn
						className="sidebar__action"
						ariaLabel="Menu"
						iconId="menu"
						iconClassName="sidebar__action-icon"
						options={[
							"New group",
							"Create a room",
							"Profile",
							"Archived",
							"Starred",
							"Settings",
							"Log out",
						]}
					/>
				</div>
			</header>
			<Alert />
			<div className="search-wrapper">
				<div className="search-icons">
					<Icon id="search" className="search-icon" />
					<button className="search__back-btn" onClick={() => setSearchQuery('')}>
						<Icon id="back" />
					</button>
				</div>
				<input 
					className="search" 
					placeholder="Search or start a new chat"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
				/>
			</div>
			<div className="sidebar__contacts">
				{filteredContacts.map((contact, index) => (
					<Contact key={contact.id || index} contact={contact} />
				))}
			</div>
		</aside>
	);
};

export default Sidebar;

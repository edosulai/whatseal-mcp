import React, { useEffect, useState } from "react";
import "./App.css";
import { BrowserRouter as Router, Route, Switch } from "react-router-dom";
import Loader from "./components/Loader";
import Home from "./pages/Home";
import Sidebar from "components/Sidebar";
import Chat from "pages/Chat";
import Pairing from "pages/Pairing";

const userPrefersDark =
	window.matchMedia &&
	window.matchMedia("(prefers-color-scheme: dark)").matches;

const API_URL = "http://localhost:5001";

function App() {
	const [appLoaded, setAppLoaded] = useState(false);
	const [startLoadProgress, setStartLoadProgress] = useState(false);
	const [waStatus, setWaStatus] = useState({ phase: 'loading', ready: false });

	useEffect(() => {
		if (userPrefersDark) document.body.classList.add("dark-theme");
		stopLoad();
	}, []);

	// Check WhatsApp status
	useEffect(() => {
		const checkStatus = async () => {
			try {
				const res = await fetch(`${API_URL}/api/status`);
				const data = await res.json();
				if (data.ok) {
					setWaStatus(data.result);
				}
			} catch (err) {
				setWaStatus({ phase: 'error', ready: false });
			}
		};
		checkStatus();
		const interval = setInterval(checkStatus, 3000);
		return () => clearInterval(interval);
	}, []);

	const stopLoad = () => {
		setStartLoadProgress(true);
		setTimeout(() => setAppLoaded(true), 3000);
	};

	if (!appLoaded) return <Loader done={startLoadProgress} />;

	// Show pairing screen if not ready
	if (waStatus.phase === 'pairing') {
		return (
			<div className="app">
				<Pairing />
			</div>
		);
	}

	return (
		<div className="app">
			<p className="app__mobile-message"> Only available on desktop 😊. </p>
			<Router>
				<div className="app-content">
					<Sidebar />
					<Switch>
						<Route path="/chat/:id" component={Chat} />
						<Route component={Home} />
					</Switch>
				</div>
			</Router>
		</div>
	);
}

export default App;

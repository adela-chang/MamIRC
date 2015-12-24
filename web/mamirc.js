/* Main state */

// Type int. At least 0.
var nextUpdateId = null;

// Type bool.
var optimizeMobile = false;

// In milliseconds. This value changes during execution depending on successful/failed requests.
var retryTimeout = 1000;

// Type str.
var csrfToken = null;


/* Miscellaneous values */

// Configurable parameter. Used by getState().
var maxMessagesPerWindow = 3000;

var curWindowMaxMessages = null;

var setInitialWindowTimeout = null;

// Type map<str,int>. It is a collection of integer constants, defined in Java code to avoid duplication. Values are set by getState().
var Flags = null;


// Global initialization function - called once after the script and page are loaded.
// Note that each module has its own initialization logic as well.
function init() {
	var cookieParts = document.cookie.split(";");
	cookieParts.forEach(function(s) {
		s = s.trim();
		if (s.startsWith("optimize-mobile="))
			optimizeMobile = s.substring(16) == "true";
	});
	if (optimizeMobile)
		maxMessagesPerWindow = 500;
	
	getState();
	checkTimeSkew();
}


/*---- Window display and data module ----*/

const windowModule = new function() {
	/* Constants */
	// Document nodes
	const windowListElem          = elemId("window-list");
	const messageListElem         = elemId("message-list");
	const memberListContainerElem = elemId("member-list-container");
	const memberListElem          = elemId("member-list");
	const showMoreMessagesElem    = elemId("show-more-messages");
	const nicknameText = document.createTextNode("");
	// Miscellaneous
	const self = this;  // Private functions and closures must use 'self', whereas public functions can use 'self' or 'this' interchangeably
	const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	
	/* Variables */
	// These variables are null before getState() returns successfully. Thereafter, most of them are non-null.
	
	// Type tuple<str profile, str party, str concatenated>.
	// Is null if windowNames is null or zero-length, otherwise this[2] equals an entry in windowNames.
	this.activeWindow = null;
	
	// Type list<str>. Length 0 or more. Each element is of the form (profile+"\n"+party).
	// Elements can be in any order, and it determines the order rendered on screen.
	this.windowNames = null;
	
	// Type map<str,window>. Key is an entry in windowNames. Each window has these properties:
	// - list<list<int seq, int flags, int timestamp, str... payload>> lines
	// - int markedReadUntil
	// - int numNewMessages
	// - bool isNickflagged
	var windowData = null;
	
	// Type map<str,object>. Key is the network profile name. Each object has these properties:
	// - str currentNickname
	// - map<str,object> channels, with values having {"members" -> list<str>, "topic" -> str or null}
	this.connectionData = null;
	
	
	/* Initialization */
	elemId("nickname").appendChild(nicknameText);
	init();
	
	
	/* Exported functions */
	
	// Called only by getState(). inData is a object parsed from JSON text.
	this.loadState = function(inData) {
		// Set simple fields
		nextUpdateId = inData.nextUpdateId;
		this.connectionData = inData.connections;
		Flags = inData.flagsConstants;
		csrfToken = inData.csrfToken;
		
		// Handle the windows
		this.windowNames = [];
		windowData = {};
		inData.windows.forEach(function(inWindow) {
			// 'inWindow' has type tuple<str profile, str party, window state>
			var windowName = inWindow[0] + "\n" + inWindow[1];
			if (self.windowNames.indexOf(windowName) != -1)
				throw "Duplicate window";
			self.windowNames.push(windowName);
			
			// Preprocess the window's lines
			var inState = inWindow[2];
			var prevTimestamp = 0;
			inState.lines.forEach(function(line) {
				prevTimestamp += line[2];  // Delta decoding
				line[2] = prevTimestamp * 1000;
			});
			var outState = createBlankWindow();
			for (var key in inState)
				outState[key] = inState[key];
			windowData[windowName] = outState;
		});
		this.activeWindow = null;
		this.windowNames.sort();
		
		// Update UI elements
		redrawWindowList();
		if (this.windowNames.length > 0) {
			var winName = inData.initialWindow;
			if (winName != null)
				winName = winName[0] + "\n" + winName[1];
			if (winName == null || this.windowNames.indexOf(winName) == -1)
				winName = this.windowNames[0];
			this.setActiveWindow(winName);
		}
	};
	
	
	// Changes activeWindow and redraws the user interface. 'name' must exist in the array windowNames.
	// Note that for efficiency, switching to the already active window does not re-render the table of lines.
	// Thus all other logic must update the active window's lines incrementally whenever new updates arrive.
	this.setActiveWindow = function(name) {
		// activeWindow may be null at the start of this method, but will be non-null afterward
		windowData[name].numNewMessages = 0;
		windowData[name].isNickflagged = false;
		if (this.activeWindow != null && this.activeWindow[2] == name) {
			redrawWindowList();
			return;
		}
		
		// Set state, refresh text, refresh window selection
		this.activeWindow = name.split("\n").concat(name);
		var profile = this.activeWindow[0];
		var party = this.activeWindow[1];
		nicknameText.data = (profile in this.connectionData) ? this.connectionData[profile].currentNickname : "";
		redrawWindowList();
		redrawChannelMembers();
		
		// Redraw all message lines in this window
		curWindowMaxMessages = 300;
		redrawMessagesTable();
		var messagesElem = elemId("messages");
		messagesElem.scrollTop = messagesElem.scrollHeight;
		
		// Tell the processor that this window was selected
		if (setInitialWindowTimeout != null)
			clearTimeout(setInitialWindowTimeout);
		setInitialWindowTimeout = setTimeout(function() {
			sendAction([["set-initial-window", profile, party]], null);
			setInitialWindowTimeout = null;
		}, 10000);
	};
	
	
	this.loadUpdates = function(inData) {
		nextUpdateId = inData.nextUpdateId;
		
		const messagesElem = elemId("messages");
		const scrollPosition = messagesElem.scrollTop;
		const scrollToBottom = scrollPosition + messagesElem.clientHeight > messagesElem.scrollHeight - 30;
		var activeWindowUpdated = false;
		inData.updates.forEach(function(payload) {
			var type = payload[0];
			
			if (type == "APPEND") {
				var windowName = payload[1] + "\n" + payload[2];
				var newWindow = false;
				if (self.windowNames.indexOf(windowName) == -1) {
					self.windowNames.push(windowName);
					self.windowNames.sort();
					windowData[windowName] = createBlankWindow();
					redrawWindowList();
					newWindow = true;
				}
				var line = payload.slice(3);
				line[2] *= 1000;
				var lines = windowData[windowName].lines;
				lines.push(line);
				var numPrefixDel = Math.max(lines.length - maxMessagesPerWindow, 0);
				lines.splice(0, numPrefixDel);
				if (self.activeWindow != null && windowName == self.activeWindow[2]) {
					var msgRow = lineDataToRowElem(line);
					if (messageListElem.firstChild != null && lines.length >= 2 && areDatesDifferent(line[2], lines[lines.length - 2][2])) {
						var dateRow = dateToRowElem(line[2]);
						if (msgRow.classList.contains("unread"))
							dateRow.classList.add("unread");
						if (msgRow.classList.contains("read"))
							dateRow.classList.add("read");
						messageListElem.appendChild(dateRow);
					}
					messageListElem.appendChild(msgRow);
					activeWindowUpdated = true;
				}
				var subtype = line[1] & Flags.TYPE_MASK;
				if (subtype == Flags.PRIVMSG) {
					if (self.activeWindow != null && windowName == self.activeWindow[2] && (line[1] & Flags.OUTGOING) != 0) {
						windowData[windowName].numNewMessages = 0;
						windowData[windowName].isNickflagged = false;
					} else if (!windowData[windowName].isMuted) {
						windowData[windowName].numNewMessages++;
						if ((line[1] & Flags.NICKFLAG) != 0)
							windowData[windowName].isNickflagged = true;
					}
					redrawWindowList();
					if (!windowData[windowName].isMuted) {
						var notiftext = null;
						if (!payload[2].startsWith("#") && !payload[2].startsWith("&") && (newWindow || (line[1] & Flags.NICKFLAG) != 0)) {
							// New private messaging window popped open, or nickflagged in one
							notificationModule.notifyMessage(windowName, null, line[3], line[4]);
						} else if ((line[1] & Flags.NICKFLAG) != 0)
							notificationModule.notifyMessage(windowName, payload[2], line[3], line[4]);
					}
				} else if (subtype == Flags.JOIN || subtype == Flags.PART || subtype == Flags.QUIT || subtype == Flags.KICK || subtype == Flags.NICK) {
					var members = self.connectionData[payload[1]].channels[payload[2]].members;
					var name = line[3];
					if (subtype == Flags.JOIN && members.indexOf(name) == -1)
						members.push(name);
					else if (subtype == Flags.PART && members.indexOf(name) != -1)
						members.splice(members.indexOf(name), 1);
					else if ((subtype == Flags.QUIT || subtype == Flags.KICK) && members.indexOf(name) != -1)
						members.splice(members.indexOf(name), 1);
					else if (subtype == Flags.NICK) {
						if (members.indexOf(name) != -1)
							members.splice(members.indexOf(name), 1);
						if (members.indexOf(line[4]) == -1)
							members.push(line[4]);
					}
					if (self.activeWindow != null && windowName == self.activeWindow[2])
						redrawChannelMembers();
				} else if (subtype == Flags.TOPIC) {
					self.connectionData[payload[1]].channels[payload[2]].topic = line[4];
				} else if (subtype == Flags.INITNOTOPIC) {
					self.connectionData[payload[1]].channels[payload[2]].topic = null;
				} else if (subtype == Flags.INITTOPIC) {
					self.connectionData[payload[1]].channels[payload[2]].topic = line[3];
				} else if (subtype == Flags.NOTICE || subtype == Flags.SERVERREPLY) {
					if (!windowData[windowName].isMuted) {
						windowData[windowName].numNewMessages++;
						redrawWindowList();
					}
				} else if (subtype == Flags.NAMES) {
					self.connectionData[payload[1]].channels[payload[2]].members = line.slice(3);
					if (self.activeWindow != null && payload[1] == self.activeWindow[0] && payload[2] == self.activeWindow[1])
						redrawChannelMembers();
				} else if (subtype == Flags.DISCONNECTED && payload[2] == "") {
					delete self.connectionData[payload[1]];
				}
			} else if (type == "MYNICK") {
				var profile = payload[1];
				var name = payload[2];
				self.connectionData[profile].currentNickname = name;
				if (self.activeWindow != null && self.activeWindow[0] == profile) {
					nicknameText.data = name;
					activeWindowUpdated = true;
				}
			} else if (type == "JOINED") {
				self.connectionData[payload[1]].channels[payload[2]] = {
					members: [],
					topic: null,
				};
			} else if (type == "PARTED" || type == "KICKED") {
				delete self.connectionData[payload[1]].channels[payload[2]];
				if (self.activeWindow != null && self.activeWindow[0] == payload[1] && self.activeWindow[1] == payload[2])
					redrawChannelMembers();
				if (type == "KICKED")
					notificationModule.notifyRaw(windowName, "You were kicked from " + payload[2] + " by " + payload[3] + ": " + payload[4]);
			} else if (type == "OPENWIN") {
				var windowName = payload[1] + "\n" + payload[2];
				var index = self.windowNames.indexOf(windowName);
				if (index == -1) {
					self.windowNames.push(windowName);
					self.windowNames.sort();
					windowData[windowName] = createBlankWindow();
					redrawWindowList();
					inputBoxModule.putText("");
					self.setActiveWindow(windowName);
				}
			} else if (type == "CLOSEWIN") {
				var windowName = payload[1] + "\n" + payload[2];
				var index = self.windowNames.indexOf(windowName);
				if (index != -1) {
					self.windowNames.splice(index, 1);
					delete windowData[windowName];
					redrawWindowList();
					if (self.activeWindow != null && windowName == self.activeWindow[2]) {
						inputBoxModule.clearText();
						if (self.windowNames.length > 0)
							self.setActiveWindow(self.windowNames[Math.min(index, self.windowNames.length - 1)]);
						else
							utilsModule.clearChildren(messageListElem);
					}
				}
			} else if (type == "MARKREAD") {
				var windowName = payload[1] + "\n" + payload[2];
				var seq = payload[3];
				windowData[windowName].markedReadUntil = seq;
				if (self.activeWindow != null && windowName == self.activeWindow[2]) {
					var lines = windowData[windowName].lines;
					var rows = messageListElem.children;
					for (var i = rows.length - 1, j = lines.length - 1; i >= 0; i--) {
						var row = rows[i];
						var lineseq;
						if (row.firstChild.colSpan == 1) {  // Ordinary message row
							lineseq = lines[j][0];
							j--;
						} else  // colSpan == 3
							lineseq = lines[j + 1][0];
						utilsModule.setClasslistItem(row.classList, "read"  , lineseq <  seq);
						utilsModule.setClasslistItem(row.classList, "unread", lineseq >= seq);
					}
					activeWindowUpdated = true;
				}
			} else if (type == "CLEARLINES") {
				var windowName = payload[1] + "\n" + payload[2];
				var seq = payload[3];
				var lines = windowData[windowName].lines;
				var i;
				for (i = 0; i < lines.length && lines[i][0] < seq; i++);
				lines.splice(0, i);
				if (self.activeWindow != null && windowName == self.activeWindow[2]) {
					var rows = messageListElem.children;
					i = lines.length - 1;
					var j;
					for (j = rows.length - 1; j >= 0; j--) {
						var row = rows[j];
						if (i < 0)
							messageListElem.removeChild(row);
						else if (row.firstChild.colSpan == 1)  // Ordinary message row
							i--;
					}
					if (i < 0)
						showMoreMessagesElem.style.display = "none";
					activeWindowUpdated = true;
				}
			} else if (type == "CONNECTED") {
				self.connectionData[payload[1]] = {
					currentNickname: null,
					channels: {},
				};
			}
		});
		
		if (activeWindowUpdated) {
			var rows = messageListElem.children;
			for (var i = rows.length - 1, j = 0; i >= 0; i--) {
				if (j >= curWindowMaxMessages)
					messageListElem.removeChild(rows[i]);
				else if (rows[i].firstChild.colSpan == 1)  // Ordinary message row
					j++;
			}
			reflowMessagesTable();
			messagesElem.scrollTop = scrollToBottom ? messagesElem.scrollHeight : scrollPosition;
		}
	};
	
	
	this.openPrivateMessagingWindow = function(target, onerror) {
		var profile = this.activeWindow[0];
		var windowName = profile + "\n" + target;
		if (this.windowNames.indexOf(windowName) == -1)
			sendAction([["open-window", profile, target]], onerror);
		else {
			this.setActiveWindow(windowName);
			inputBoxModule.putText("");
		}
	};
	
	
	/* Private functions */
	
	function init() {
		showMoreMessagesElem.style.display = "none";
		showMoreMessagesElem.getElementsByTagName("a")[0].onclick = function() {
			if (self.activeWindow == null)
				return;
			var temp = Math.sqrt(curWindowMaxMessages / 300) + 0.5;
			temp = Math.round(temp * temp * 300);
			curWindowMaxMessages = Math.min(temp, 10000);
			redrawMessagesTable();
			return false;
		};
	}
	
	
	// Clears the window list HTML container element and rebuilds it from scratch based on
	// the current states of windowNames, windowData[windowName].newMessages, and activeWindow.
	function redrawWindowList() {
		utilsModule.clearChildren(windowListElem);
		self.windowNames.forEach(function(windowName) {
			// windowName has type str, and is of the form (profile+"\n"+party)
			var parts = windowName.split("\n");
			var profile = parts[0];
			var party = parts[1];
			
			// Create the anchor element
			var a = utilsModule.createElementWithText("a", party != "" ? party : profile);
			var n = windowData[windowName].numNewMessages;
			if (n > 0) {
				a.appendChild(utilsModule.createElementWithText("span", " ("));
				a.appendChild(utilsModule.createElementWithText("span", n.toString()));
				a.appendChild(utilsModule.createElementWithText("span", ")"));
			}
			if (windowData[windowName].isNickflagged)
				a.classList.add("nickflag");
			a.href = "#";
			a.onclick = function() {
				self.setActiveWindow(windowName);
				return false;
			};
			var menuItems = [];
			if (windowData[windowName].isMuted)
				menuItems.push(["Unmute window", function() { windowData[windowName].isMuted = false; }]);
			else {
				menuItems.push(["Mute window", function() {
					windowData[windowName].isMuted = true;
					windowData[windowName].numNewMessages = 0;
					windowData[windowName].isNickflagged = false;
					redrawWindowList();
				}]);
			}
			if (party == "" && profile in self.connectionData || profile in self.connectionData && party in self.connectionData[profile].channels)
				menuItems.push(["Close window", null]);
			else
				menuItems.push(["Close window", function() { sendAction([["close-window", profile, party]], null); }]);
			a.oncontextmenu = menuModule.makeOpener(menuItems);
			
			var li = document.createElement("li");
			li.appendChild(a);
			if (party == "")
				li.className = "profile";
			windowListElem.appendChild(li);
		});
		refreshWindowSelection();
		
		var totalNewMsg = 0;
		for (var key in windowData)
			totalNewMsg += windowData[key].numNewMessages;
		if (self.activeWindow != null)
			document.title = (totalNewMsg > 0 ? "(" + totalNewMsg + ") " : "") + (self.activeWindow[1] != "" ? self.activeWindow[1] + " - " : "") + self.activeWindow[0] + " - MamIRC";
	}
	
	
	// Refreshes the selection class of each window <li> element based on the states of windowNames and activeWindow.
	// This assumes that the list of HTML elements is already synchronized with windowNames.
	function refreshWindowSelection() {
		if (self.activeWindow == null)
			return;
		var windowLis = windowListElem.getElementsByTagName("li");
		self.windowNames.forEach(function(name, i) {
			utilsModule.setClasslistItem(windowLis[i].classList, "selected", name == self.activeWindow[2]);
		});
	}
	
	
	// Refreshes the channel members text element based on the states of
	// connectionData[profileName].channels[channelName].members and activeWindow.
	function redrawChannelMembers() {
		utilsModule.clearChildren(memberListElem);
		var profile = self.activeWindow[0], party = self.activeWindow[1];
		if (profile in self.connectionData && party in self.connectionData[profile].channels) {
			var members = self.connectionData[profile].channels[party].members;
			members.sort(function(s, t) {  // Safe mutation; case-insensitive ordering
				return s.toLowerCase().localeCompare(t.toLowerCase());
			});
			members.forEach(function(name) {
				var li = utilsModule.createElementWithText("li", name);
				li.oncontextmenu = menuModule.makeOpener([["Open PM window", function() { self.openPrivateMessagingWindow(name, null); }]]);
				memberListElem.appendChild(li);
			});
			memberListContainerElem.style.removeProperty("display");
		} else
			memberListContainerElem.style.display = "none";
	}
	
	
	function redrawMessagesTable() {
		utilsModule.clearChildren(messageListElem);
		var lines = windowData[self.activeWindow[2]].lines;
		for (var i = Math.max(lines.length - curWindowMaxMessages, 0), head = true; i < lines.length; i++, head = false) {
			// 'line' has type tuple<int seq, int timestamp, str line, int flags>
			var line = lines[i];
			var msgRow = lineDataToRowElem(line);
			if (!head && areDatesDifferent(line[2], lines[i - 1][2])) {
				var dateRow = dateToRowElem(line[2]);
				if (msgRow.classList.contains("unread"))
					dateRow.classList.add("unread");
				if (msgRow.classList.contains("read"))
					dateRow.classList.add("read");
				messageListElem.appendChild(dateRow);
			}
			messageListElem.appendChild(msgRow);
		}
		reflowMessagesTable();
		if (lines.length <= curWindowMaxMessages)
			showMoreMessagesElem.style.display = "none";
		else
			showMoreMessagesElem.style.removeProperty("display");
	}
	
	
	function reflowMessagesTable() {
		var tableElem = messageListElem.parentNode;
		tableElem.style.tableLayout = "auto";
		if (messageListElem.children.length > 0) {
			var cols = messageListElem.firstChild.children;
			var widths = [cols[0].clientWidth, cols[1].clientWidth];
			tableElem.style.tableLayout = "fixed";
			cols[0].style.width = widths[0] + "px";
			cols[1].style.width = widths[1] + "px";
		}
	}
	
	
	// Converts a window line (which is a tuple of str/int) into a <tr> element for the main messages table.
	// The window line comes from windowData[windowName].lines[i] (which can be from loadState() or loadUpdates()).
	// This function can only be called for lines in the active window; it must not be used for off-screen windows.
	function lineDataToRowElem(line) {
		// Input variables
		const sequence = line[0];
		const flags = line[1];
		const timestamp = line[2];
		const payload = line.slice(3);
		const type = flags & Flags.TYPE_MASK;
		
		// Output variables
		var who = "\u25CF";    // Type str
		var nameColor = null;  // Type str or null
		var lineElems = [];    // Type list<domnode>
		var quoteText = null;  // Type str or null
		var tr = document.createElement("tr");
		
		// Take action depending on head of payload
		if (type == Flags.PRIVMSG) {
			who = payload[0];
			nameColor = nickColorModule.getNickColor(who);
			var s = payload[1];
			var mematch = formatTextModule.matchMeMessage(s);
			if (mematch != null)
				s = mematch[1];
			
			if ((flags & Flags.OUTGOING) != 0)
				tr.classList.add("outgoing");
			if ((flags & Flags.NICKFLAG) != 0)
				tr.classList.add("nickflag");
			quoteText = formatTextModule.fancyToPlainText(s.replace(/\t/g, " "));
			lineElems = formatTextModule.fancyTextToElems(s);
			if (mematch != null) {
				tr.classList.add("me-action");
				quoteText = "* " + who + " " + quoteText;
			} else {
				quoteText = "<" + who + "> " + quoteText;
			}
			
		} else if (type == Flags.NOTICE) {
			who = "(" + payload[0] + ")";
			lineElems = formatTextModule.fancyTextToElems(payload[1]);
		} else if (type == Flags.NICK) {
			lineElems.push(document.createTextNode(payload[0] + " changed their name to " + payload[1]));
			tr.classList.add("nick-change");
		} else if (type == Flags.JOIN) {
			who = "\u2192";  // Rightwards arrow
			lineElems.push(document.createTextNode(payload[0] + " joined the channel"));
			tr.classList.add("user-enter");
		} else if (type == Flags.PART) {
			who = "\u2190";  // Leftwards arrow
			lineElems.push(document.createTextNode(payload[0] + " left the channel"));
			tr.classList.add("user-exit");
		} else if (type == Flags.QUIT) {
			who = "\u2190";  // Leftwards arrow
			lineElems = formatTextModule.fancyTextToElems(payload[1]);
			lineElems.splice(0, 0, document.createTextNode(payload[0] + " has quit: "));
			tr.classList.add("user-exit");
		} else if (type == Flags.KICK) {
			who = "\u2190";  // Leftwards arrow
			lineElems = formatTextModule.fancyTextToElems(payload[2]);
			lineElems.splice(0, 0, document.createTextNode(payload[0] + " was kicked by " + payload[1] + ": "));
			tr.classList.add("user-exit");
		} else if (type == Flags.TOPIC) {
			lineElems = formatTextModule.fancyTextToElems(payload[1]);
			lineElems.splice(0, 0, document.createTextNode(payload[0] + " set the channel topic to: "));
		} else if (type == Flags.INITNOTOPIC) {
			lineElems.push(document.createTextNode("No channel topic is set"));
		} else if (type == Flags.INITTOPIC) {
			lineElems = formatTextModule.fancyTextToElems(payload[0]);
			lineElems.splice(0, 0, document.createTextNode("The channel topic is: "));
		} else if (type == Flags.SERVERREPLY) {
			lineElems = formatTextModule.fancyTextToElems(payload[1]);
		} else if (type == Flags.NAMES) {
			lineElems.push(document.createTextNode("Users in channel: " + payload.join(", ")));
			tr.classList.add("user-list");
		} else if (type == Flags.MODE) {
			lineElems.push(document.createTextNode(payload[0] + " set mode " + payload[1]));
			tr.classList.add("mode-change");
		} else if (type == Flags.CONNECTING) {
			var str = "Connecting to server at " + payload[0] + ", port " + payload[1] + ", " + (payload[2] ? "SSL" : "no SSL") + "...";
			lineElems.push(document.createTextNode(str));
		} else if (type == Flags.CONNECTED) {
			lineElems.push(document.createTextNode("Socket opened to IP address " + payload[0]));
		} else if (type == Flags.DISCONNECTED) {
			lineElems.push(document.createTextNode("Disconnected from server"));
		} else {
			who = "RAW";
			lineElems.push(document.createTextNode("flags=" + flags + " " + payload.join(" ")));
		}
		
		// Make timestamp cell
		var td = utilsModule.createElementWithText("td", formatDate(timestamp));
		tr.appendChild(td);
		
		// Make nickname cell
		td = utilsModule.createElementWithText("td", who);
		if (who != "\u25CF" && who != "\u2190" && who != "\u2192" && who != "RAW")
			td.oncontextmenu = menuModule.makeOpener([["Open PM window", function() { self.openPrivateMessagingWindow(who, null); }]]);
		if (nameColor != null)
			td.style.color = nameColor;
		tr.appendChild(td);
		
		// Make message cell and its sophisticated context menu
		td = document.createElement("td");
		lineElems.forEach(function(elem) {
			td.appendChild(elem);
		});
		var menuItems = [["Quote text", null]];
		if (quoteText != null) {
			menuItems[0][1] = function() {
				inputBoxModule.putText(quoteText);
			};
		}
		menuItems.push(["Mark read to here", function() {
			if (tr.classList.contains("read") && !confirm("Do you want to move mark upward?"))
				return;
			sendAction([["mark-read", self.activeWindow[0], self.activeWindow[1], sequence + 1]], null);
		}]);
		menuItems.push(["Clear to here", function() {
			if (confirm("Do you want to clear text?"))
				sendAction([["clear-lines", self.activeWindow[0], self.activeWindow[1], sequence + 1]], null);
		}]);
		td.oncontextmenu = menuModule.makeOpener(menuItems);
		tr.appendChild(td);
		
		// Finishing touches
		if (sequence < windowData[self.activeWindow[2]].markedReadUntil)
			tr.classList.add("read");
		else
			tr.classList.add("unread");
		return tr;
	}
	
	
	function dateToRowElem(timestamp) {
		var tr = document.createElement("tr");
		var td = document.createElement("td");
		td.colSpan = 3;
		var d = new Date(timestamp);
		var text = d.getFullYear() + "\u2012" + utilsModule.twoDigits(d.getMonth() + 1) + "\u2012" + utilsModule.twoDigits(d.getDate()) + "\u2012" + DAYS_OF_WEEK[d.getDay()];
		var span = utilsModule.createElementWithText("span", text);
		td.appendChild(span);
		tr.appendChild(td);
		return tr;
	}
	
	
	function areDatesDifferent(ts0, ts1) {
		var d0 = new Date(ts0);
		var d1 = new Date(ts1);
		return d0.getFullYear() != d1.getFullYear() || d0.getMonth() != d1.getMonth() || d0.getDate() != d1.getDate();
	}
	
	
	function createBlankWindow() {
		return {
			lines: [],
			markedReadUntil: 0,
			numNewMessages: 0,
			isNickflagged: false,
			isMuted: false,
		};
	}
	
	
	// Converts a Unix millisecond timestamp to a string, in the preferred format for lineDataToRowElem().
	function formatDate(timestamp) {
		var d = new Date(timestamp);
		var two = utilsModule.twoDigits;
		if (!optimizeMobile) {
			return two(d.getDate()) + "-" + DAYS_OF_WEEK[d.getDay()] + " " +
				two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
		} else {
			return DAYS_OF_WEEK[d.getDay()] + " " + two(d.getHours()) + ":" + two(d.getMinutes());
		}
	}
};



/*---- Text formatting module ----*/

// Handles formatting codes and URLs in raw IRC message strings. Stateless module.
const formatTextModule = new function() {
	/* Constants */
	const SPECIAL_FORMATTING_REGEX = /[\u0002\u0003\u000F\u0016\u001D\u001F]|https?:\/\//;
	const FORMAT_CODE_REGEX = /^(.*?)(?:[\u0002\u000F\u0016\u001D\u001F]|\u0003(?:(\d{1,2})(?:,(\d{1,2}))?)?)/;
	const REMOVE_FORMATTING_REGEX = /[\u0002\u000F\u0016\u001D\u001F]|\u0003(?:\d{1,2}(?:,\d{1,2})?)?/g;
	const URL_REGEX0 = /^(|.*? )(https?:\/\/[^ ]+)/;
	const URL_REGEX1 = /^(.*?\()(https?:\/\/[^ ()]+)/;
	const ME_ACTION_REGEX = /^\u0001ACTION (.*)\u0001$/;
	const TEXT_COLORS = [
		// The 16 mIRC colors: http://www.mirc.com/colors.html ; http://en.wikichip.org/wiki/irc/colors
		"#FFFFFF", "#000000", "#00007F", "#009300", "#FF0000", "#7F0000", "#9C009C", "#FC7F00",
		"#FFFF00", "#00FC00", "#009393", "#00FFFF", "#0000FC", "#FF00FF", "#7F7F7F", "#D2D2D2",
	];
	
	/* Exported functions */
	
	// Given a string with possible IRC formatting control codes and plain text URLs,
	// this returns an array of DOM nodes representing text with formatting and anchor links.
	// Types: str is string, result is list<HTMLElement>. Pure function.
	this.fancyTextToElems = function(str) {
		// Take fast path if string contains no formatting or potential URLs
		if (!SPECIAL_FORMATTING_REGEX.test(str))
			return [document.createTextNode(str)];
		
		// Current formatting state
		var bold = false;
		var italic = false;
		var underline = false;
		var background = 0;
		var foreground = 1;
		
		// Process formatting commands and chunks of text
		var result = [];
		while (str != "") {
			var formatMatch = FORMAT_CODE_REGEX.exec(str);
			var strPartEnd = formatMatch != null ? formatMatch[1].length : str.length;
			if (strPartEnd > 0) {
				// Process text
				var chunk = str.substr(0, strPartEnd);
				var elems = [];
				while (chunk != "") {
					var urlMatch = URL_REGEX0.exec(chunk);
					if (urlMatch == null)
						urlMatch = URL_REGEX1.exec(chunk);
					var chunkPartEnd = urlMatch != null ? urlMatch[1].length : chunk.length;
					if (chunkPartEnd > 0)
						elems.push(document.createTextNode(chunk.substr(0, chunkPartEnd)));
					if (urlMatch == null)
						break;
					var a = utilsModule.createElementWithText("a", urlMatch[2]);
					a.href = urlMatch[2];
					a.target = "_blank";
					a.oncontextmenu = function(ev) { ev.stopPropagation(); };  // Show system context menu instead of custom menu
					elems.push(a);
					chunk = chunk.substring(urlMatch[0].length);
				}
				
				if (background != 0 || foreground != 1) {
					var elem = document.createElement("span");
					if (background != 0)
						elem.style.backgroundColor = TEXT_COLORS[background];
					if (foreground != 1)
						elem.style.color = TEXT_COLORS[foreground];
					elems.forEach(function(e) {
						elem.appendChild(e);
					});
					elems = [elem];
				}
				var temp = [[bold, "b"], [italic, "i"], [underline, "u"]];
				temp.forEach(function(pair) {
					if (pair[0]) {
						var elem = document.createElement(pair[1]);
						elems.forEach(function(e) {
							elem.appendChild(e);
						});
						elems = [elem];
					}
				});
				elems.forEach(function(e) {
					result.push(e);
				});
			}
			if (formatMatch == null)
				break;
			
			// Process format code
			switch (str.charCodeAt(strPartEnd)) {
				case 0x02:
					bold = !bold;
					break;
				case 0x1D:
					italic = !italic;
					break;
				case 0x1F:
					underline = !underline;
					break;
				case 0x16:  // Reverse
					var temp = foreground;
					foreground = background;
					background = temp;
					break;
				case 0x0F:  // Plain
					bold = false;
					italic = false;
					underline = false;
					background = 0;
					foreground = 1;
					break;
				case 0x03:  // Color
					var fore = formatMatch[2] != undefined ? parseInt(formatMatch[2], 10) : 1;
					var back = formatMatch[3] != undefined ? parseInt(formatMatch[3], 10) : 0;
					if (fore < TEXT_COLORS.length) foreground = fore;
					if (back < TEXT_COLORS.length) background = back;
					break;
				default:
					throw "Assertion error";
			}
			str = str.substring(formatMatch[0].length);
		}
		
		// Epilog
		if (result.length == 0)  // Prevent having an empty <td> to avoid style/display problems
			result.push(document.createTextNode(""));
		return result;
	}
	
	// Attempts to match the given string agaist the '/me' action regex, returning
	// an array of capture group strings if successful or null if there is no match.
	// Types: str is string, result is (list<string> with extra properties due to RegExp.exec()) / null. Pure function.
	this.matchMeMessage = function(str) {
		return ME_ACTION_REGEX.exec(str);
	};
	
	// Returns a new string representing the given string with all IRC formatting codes removed.
	// Types: str is string, result is string. Pure function.
	this.fancyToPlainText = function(str) {
		return str.replace(REMOVE_FORMATTING_REGEX, "");
	};
};



/*---- Input text box module ----*/

// Handles the input text box - command parsing, tab completion, and text setting.
const inputBoxModule = new function() {
	/* Constants */
	const inputBoxElem = elemId("input-box");
	// The default of 400 is a safe number to use, because an IRC protocol line
	// is generally limited to 512 bytes, including prefix and parameters and newline
	const maxBytesPerLine = 400;  // Type integer
	// For grabbing the prefix to perform tab completion
	const TAB_COMPLETION_REGEX = /^(|.* )([^ ]*)$/;
	// A table of commands with regular structures (does not include all commands, such as /msg). Format per entry:
	// key is command name with slash, value is {minimum number of parameters, maximum number of parameters}.
	const OUTGOING_COMMAND_PARAM_COUNTS = {
		"/info"   : [0, 1],
		"/invite" : [2, 2],
		"/join"   : [1, 2],
		"/links"  : [0, 2],
		"/list"   : [0, 2],
		"/nick"   : [1, 1],
		"/part"   : [1, 1],
		"/stats"  : [0, 2],
		"/time"   : [0, 1],
		"/users"  : [0, 1],
		"/version": [0, 1],
		"/who"    : [0, 2],
		"/whois"  : [1, 2],
		"/whowas" : [1, 3],
	};
	
	/* Variables */
	var prevTabCompletion = null;  // Type tuple<begin:integer, end:integer, prefix:string, name:string> / null.
	
	/* Initialization */
	elemId("footer").getElementsByTagName("form")[0].onsubmit = handleLine;
	inputBoxElem.oninput = colorizeLine;
	inputBoxElem.onblur = clearTabCompletion;
	inputBoxElem.onkeydown = function(ev) {
		if (ev.keyCode == 9) {
			doTabCompletion();
			return false;
		} else {
			clearTabCompletion();
			return true;
		}
	};
	inputBoxElem.value = "";
	
	/* Private functions */
	
	function handleLine() {
		var inputStr = inputBoxElem.value;
		var activeWindow = windowModule.activeWindow;
		if (activeWindow == null || inputStr == "")
			return false;
		if (isLineOverlong()) {
			alert("Line is too long");
			return false;
		}
		
		var onerror = function(reason) {
			errorMsgModule.addMessage("Sending line failed (" + reason + "): " + inputStr);
		};
		
		if (!inputStr.startsWith("/") || inputStr.startsWith("//")) {  // Ordinary message
			if (inputStr.startsWith("//"))  // Ordinary message beginning with slash
				inputStr = inputStr.substring(1);
			sendMessage(activeWindow[0], activeWindow[1], inputStr, onerror);
			
		} else {  // Command or special message
			// The user input command is case-insensitive. The command sent to the server will be in uppercase.
			var parts = inputStr.split(" ");
			var cmd = parts[0].toLowerCase();
			
			// Irregular commands
			if (cmd == "/msg" && parts.length >= 3) {
				var profile = activeWindow[0];
				var party = parts[1];
				var windowName = profile + "\n" + party;
				var text = utilsModule.nthRemainingPart(inputStr, 2);
				if (windowModule.windowNames.indexOf(windowName) == -1) {
					sendAction([["open-window", profile, party], ["send-line", profile, "PRIVMSG " + party + " :" + text]], onerror);
				} else {
					windowModule.setActiveWindow(windowName);
					sendMessage(profile, party, text, onerror);
				}
			} else if (cmd == "/me" && parts.length >= 2) {
				sendMessage(activeWindow[0], activeWindow[1], "\u0001ACTION " + utilsModule.nthRemainingPart(inputStr, 1) + "\u0001", onerror);
			} else if (cmd == "/notice" && parts.length >= 3) {
				sendAction([["send-line", activeWindow[0], "NOTICE " + parts[1] + " :" + utilsModule.nthRemainingPart(inputStr, 2)]], onerror);
			} else if (cmd == "/part" && parts.length == 1) {
				sendAction([["send-line", activeWindow[0], "PART " + activeWindow[1]]], onerror);
			} else if (cmd == "/query" && parts.length == 2) {
				windowModule.openPrivateMessagingWindow(parts[1], onerror);
			} else if (cmd == "/topic" && parts.length >= 2) {
				sendAction([["send-line", activeWindow[0], "TOPIC " + activeWindow[1] + " :" + utilsModule.nthRemainingPart(inputStr, 1)]], onerror);
			} else if (cmd == "/kick" && parts.length >= 2) {
				var reason = parts.length == 2 ? "" : utilsModule.nthRemainingPart(inputStr, 2);
				sendAction([["send-line", activeWindow[0], "KICK " + activeWindow[1] + " " + parts[1] + " :" + reason]], onerror);
			} else if (cmd == "/names" && parts.length == 1) {
				var params = activeWindow[1] != "" ? " " + activeWindow[1] : "";
				sendAction([["send-line", activeWindow[0], "NAMES" + params]], onerror);
			} else if (cmd in OUTGOING_COMMAND_PARAM_COUNTS) {
				// Regular commands
				var minMaxParams = OUTGOING_COMMAND_PARAM_COUNTS[cmd];
				var numParams = parts.length - 1;
				if (numParams >= minMaxParams[0] && numParams <= minMaxParams[1]) {
					var params = numParams > 0 ? " " + parts.slice(1).join(" ") : "";
					sendAction([["send-line", activeWindow[0], cmd.substring(1).toUpperCase() + params]], onerror);
				} else {
					alert("Invalid command");
					return false;  // Don't clear the text box
				}
			} else {
				alert("Invalid command");
				return false;  // Don't clear the text box
			}
		}
		inputBoxElem.value = "";
		return false;  // To prevent the form submitting
	}
	
	// Change classes of text box based on '/commands' and overlong text
	function colorizeLine() {
		var text = inputBoxElem.value;
		utilsModule.setClasslistItem(inputBoxElem.classList, "is-command", text.startsWith("/") && !text.startsWith("//"));
		utilsModule.setClasslistItem(inputBoxElem.classList, "is-overlong", isLineOverlong());
	}
	
	function isLineOverlong() {
		var text = inputBoxElem.value;
		var checktext;
		if (text.startsWith("//"))
			checktext = text.substring(1);
		else if (!text.startsWith("/"))
			checktext = text;
		else {  // Starts with '/' but not '//'
			var parts = text.split(" ");
			var cmd = parts[0].toLowerCase();
			if ((cmd == "/kick" || cmd == "/msg") && parts.length >= 3)
				checktext = utilsModule.nthRemainingPart(text, 2);
			else if ((cmd == "/me" || cmd == "/topic") && parts.length >= 2)
				checktext = utilsModule.nthRemainingPart(text, 1);
			else
				checktext = text;
		}
		return utilsModule.countUtf8Bytes(checktext) > maxBytesPerLine;
	}
	
	function doTabCompletion() {
		do {  // Simulate goto
			if (document.activeElement != inputBoxElem)
				break;
			var index = inputBoxElem.selectionStart;
			if (index != inputBoxElem.selectionEnd)
				break;
			if (windowModule.activeWindow == null)
				break;
			var profile = windowModule.activeWindow[0];
			var party = windowModule.activeWindow[1];
			if (!(profile in windowModule.connectionData) || !(party in windowModule.connectionData[profile].channels))
				break;
			
			var text = inputBoxElem.value;
			var match;
			var prefix;
			if (prevTabCompletion == null) {
				match = TAB_COMPLETION_REGEX.exec(text.substr(0, index));
				prefix = match[2].toLowerCase();
				if (prefix.length == 0)
					break;
			} else {
				match = null;
				prefix = prevTabCompletion[2];
			}
			
			var candidates = windowModule.connectionData[profile].channels[party].members.filter(function(name) {
				return name.toLowerCase().startsWith(prefix); });
			if (candidates.length == 0)
				break;
			candidates.sort(function(s, t) {
				return s.toLowerCase().localeCompare(t.toLowerCase()); });
			
			var candidate;
			var beginning;
			if (prevTabCompletion == null) {
				candidate = candidates[0];
				beginning = match[1];
			} else {
				var oldcandidate = prevTabCompletion[3].toLowerCase();
				var i;  // Skip elements until one is strictly larger
				for (i = 0; i < candidates.length && candidates[i].toLowerCase() <= oldcandidate; i++);
				candidates.push(candidates[0]);  // Wrap-around
				candidate = candidates[i];
				beginning = text.substr(0, prevTabCompletion[0]);
			}
			var tabcomp = candidate;
			if (beginning.length == 0)
				tabcomp += ": ";
			else if (index < text.length)
				tabcomp += " ";
			inputBoxElem.value = beginning + tabcomp + text.substring(index);
			prevTabCompletion = [beginning.length, beginning.length + tabcomp.length, prefix, candidate];
			inputBoxElem.selectionStart = inputBoxElem.selectionEnd = prevTabCompletion[1];
			return;  // Don't clear the current tab completion
			
		} while (false);
		clearTabCompletion();
	}
	
	function clearTabCompletion() {
		prevTabCompletion = null;
	}
	
	/* Exported functions */
	
	// Sets the text box to the given string, gives input focus, and puts the caret at the end.
	// Types: str is string, result is void.
	this.putText = function(str) {
		inputBoxElem.value = str;
		inputBoxElem.focus();
		inputBoxElem.selectionStart = inputBoxElem.selectionEnd = str.length;
	};
	
	// Clears the text in the text box. Returns nothing.
	// Types: result is void.
	this.clearText = function() {
		inputBoxElem.value = "";
	};
};



/*---- Context menu module ----*/

// Manages a singleton context menu that can be shown with specific menu items or hidden.
const menuModule = new function() {
	/* Initialization */
	const htmlElem = document.documentElement;
	htmlElem.onmousedown = closeMenu;
	htmlElem.onkeydown = function(ev) {
		if (ev.keyCode == 27)  // Escape
			closeMenu();
	};
	
	/* Exported functions */
	// Based on the given list of menu items, this returns an event handler function to pop open the context menu.
	// Types: items is list<pair<text:string, handler:(function(Event)->void)/null>>, result is function(ev:Event)->Boolean.
	this.makeOpener = function(items) {
		return function(ev) {
			// If text is currently selected, show the native context menu instead -
			// this allows the user to copy the highlight text, search the web, etc.
			if (window.getSelection().toString() != "")
				return;
			closeMenu();
			var div = document.createElement("div");
			div.id = "menu";
			div.style.left = ev.pageX + "px";
			div.style.top  = ev.pageY + "px";
			var ul = document.createElement("ul");
			
			items.forEach(function(item) {
				var li = document.createElement("li");
				var child;
				if (item[1] == null) {
					child = utilsModule.createElementWithText("span", item[0]);
					child.className = "disabled";
				} else {
					child = utilsModule.createElementWithText("a", item[0]);
					child.href = "#";
					child.onclick = function() {
						closeMenu();
						item[1]();
						return false;
					};
				}
				li.appendChild(child);
				ul.appendChild(li);
			});
			
			div.appendChild(ul);
			div.onmousedown = function(ev) { ev.stopPropagation(); };  // Prevent entire-document event handler from dismissing menu
			document.getElementsByTagName("body")[0].appendChild(div);
			return false;
		};
	};
	
	/* Private functions */
	// Deletes the single global context menu <div> element if one is present.
	// Returns nothing. Types: result is void.
	function closeMenu() {
		var elem = elemId("menu");
		if (elem != null)
			elem.parentNode.removeChild(elem);
	}
};



/*---- Nickname colorization module ----*/

// Associates each nickname with a color. The mapping is based on hashing, and thus is stateless and consistent.
const nickColorModule = new function() {
	/* Constants */
	const colorTable = [
		// 8 hand-tuned colors that are fairly perceptually uniform
		"DC7979", "E1A056", "C6CA34", "5EA34D", "62B5C6", "7274CF", "B97DC2", "949494",
		// 56 averages of pairs of the colors above, blended in sRGB
		"DF8E69", "D1A85E", "AC9066", "AD9BA5", "B177AB", "CB7BA3", "BD8787", "DF8E69",
		"D4B747", "B0A252", "B1AB9B", "B58CA1", "CE9099", "C09A7A", "D1A85E", "D4B747",
		"9DB842", "9EC095", "A3A69B", "C0A992", "AFB271", "AC9066", "B0A252", "9DB842",
		"60AC99", "698E9F", "959296", "7D9C77", "AD9BA5", "B1AB9B", "9EC095", "60AC99",
		"6A99CB", "969CC4", "7EA6AF", "B177AB", "B58CA1", "A3A69B", "698E9F", "6A99CB",
		"9B79C9", "8485B5", "CB7BA3", "CE9099", "C0A992", "959296", "969CC4", "9B79C9",
		"A889AD", "BD8787", "C09A7A", "AFB271", "7D9C77", "7EA6AF", "8485B5", "A889AD",
	];
	
	/* Variables */
	var nickColorCache = {};
	var nickColorCacheSize = 0;
	
	/* Exported functions */
	// Returns the color associated with the given nickname, based on a hashing algorithm.
	// 'name' is an arbitrary string, and the result is a CSS hexadecimal color in the format "#ABC012".
	// Types: name is string, result is string.
	this.getNickColor = function(name) {
		if (!(name in nickColorCache)) {
			var hash = 1;  // Signed 32-bit integer
			for (var i = 0; i < name.length; i++) {
				for (var j = 0; j < 128; j++) {  // LFSR based on CRC-32
					if (j % 19 == 0)
						hash = (hash + name.charCodeAt(i)) | 0;
					hash = (hash >>> 1) ^ (-(hash & 1) & 0xEDB88320);
				}
			}
			if (nickColorCacheSize > 100) {
				nickColorCache = {};
				nickColorCacheSize = 0;
			}
			nickColorCache[name] = "#" + colorTable[(hash >>> 0) % colorTable.length];
			nickColorCacheSize++;
		}
		return nickColorCache[name];
	};
};



/*---- Toast notifications module ----*/

// Manages desktop toast notifications and allows new ones to be posted.
const notificationModule = new function() {
	/* Variables */
	var enabled = "Notification" in window;
	
	/* Initialization */
	if (enabled)
		Notification.requestPermission();
	
	/* Exported functions */
	
	// Posts a notification of the given message text in the given window on the given channel by the given user.
	// 'windowName' is in the format 'profile+"\n"+party'. 'message' has '/me' auto-detected and formatting codes automatically stripped.
	// Types: windowName is string, channel is string/null, user is string, message is string, result is void.
	this.notifyMessage = function(windowName, channel, user, message) {
		var s = (channel != null) ? (channel + " ") : "";
		var match = formatTextModule.matchMeMessage(message);
		s += (match == null) ? ("<" + user + ">") : ("* " + user);
		s += " " + formatTextModule.fancyToPlainText((match == null) ? message : match[1]);
		this.notifyRaw(windowName, s);
	};
	
	// Posts a notification of the given raw text in the given window. 'windowName' is in the format 'profile+"\n"+party'.
	// Types: windowName is string, text is string, result is void.
	this.notifyRaw = function(windowName, text) {
		if (enabled) {
			var opts = {icon: "tomoe-mami-icon-text.png"};
			var notif = new Notification(truncateLongText(text), opts);
			notif.onclick = function() {
				windowModule.setActiveWindow(windowName);
			};
			setTimeout(function() { notif.close(); }, 10000);  // Hide the notification sooner than Google Chrome's ~20-second timeout
		}
	};
	
	/* Private functions */
	
	// Returns either str if short enough, or some prefix of str with "..." appended.
	// The function is needed because Mozilla Firefox allows ridiculously long notification lines to be displayed.
	// Types: str is string, result is string.
	function truncateLongText(str) {
		var LIMIT = 5;
		var i = 0;
		// count is the number of Unicode code points seen, not UTF-16 code units
		for (var count = 0; i < str.length && count < LIMIT; i++) {
			var cc = str.charCodeAt(i);
			if (cc < 0xD800 || cc >= 0xDC00)  // Increment if ordinary character or low surrogate, but not high surrogate
				count++;
		}
		if (i == str.length)
			return str;
		else
			return str.substr(0, i) + "...";
	}
};



/*---- Utilities module ----*/

// A set of functions that are somewhat general, not too specific to the problem domain of MamIRC.
// This module only contains public, stateless functions. These functions may return a new
// value or change an argument's state. They never read/write global state or perform I/O.
const utilsModule = new function() {
	/* Exported functions */
	
	// Returns the rest of the string after exactly n spaces. For example: nthRemainingPart("a b c", 0) -> "a b c";
	// nthRemainingPart("a b c", 1) -> "b c"; nthRemainingPart("a b c", 3) -> throws exception.
	// Types: str is string, n is integer, result is string. Pure function.
	this.nthRemainingPart = function(str, n) {
		var j = 0;
		for (var i = 0; i < n; i++) {
			j = str.indexOf(" ", j) + 1;
			if (j == 0)
				throw "Space not found";
		}
		return str.substring(j);
	};
	
	// Returns the number of bytes in the UTF-8 encoded representation of the given string. Handles paired
	// and unpaired UTF-16 surrogates correctly. Types: str is string, result is integer. Pure function.
	this.countUtf8Bytes = function(str) {
		var result = 0;
		for (var i = 0; i < str.length; i++) {
			var c = str.charCodeAt(i);
			if (c < 0x80)
				result += 1;
			else if (c < 0x800)
				result += 2;
			else if (0xD800 <= c && c < 0xDC00 && i + 1 < str.length  // Check for properly paired UTF-16 high and low surrogates
					&& 0xDC00 <= str.charCodeAt(i + 1) && str.charCodeAt(i + 1) < 0xE000) {
				result += 4;
				i++;
			} else
				result += 3;
		}
		return result;
	};
	
	// Converts the given integer to a two-digit string. For example, 0 -> "00", 9 -> "09", 23 -> "23".
	// Types: n is integer, result is string. Pure function.
	this.twoDigits = function(n) {
		return (n < 10 ? "0" : "") + n;
	};
	
	// Removes all the children of the given DOM element. Returns nothing.
	// Types: elem is HTMLElement (mutable), result is void.
	this.clearChildren = function(elem) {
		while (elem.firstChild != null)
			elem.removeChild(elem.firstChild);
	};
	
	// Returns a new DOM element with the given tag name, with a text node of the given content
	// as its only child. Types: tagName is string, text is string, result is HTMLElement. Pure function.
	this.createElementWithText = function(tagName, text) {
		var result = document.createElement(tagName);
		result.appendChild(document.createTextNode(text));
		return result;
	};
	
	// Modifies the given class list so that it contains / does not contain the given token name. Returns nothing.
	// Types: clslst is DOMTokenList (mutable), name is string, enable is Boolean, result is void.
	this.setClasslistItem = function(clslst, name, enable) {
		if (clslst.contains(name) != enable)
			clslst.toggle(name);
	};
};



/*---- Alert messages module ----*/

// Manages the panel of error messages and allows new lines to be added.
const errorMsgModule = new function() {
	/* Constants */
	const errorMsgContainerElem = elemId("error-msg-container");
	const errorMsgElem          = elemId("error-msg");
	
	/* Initialization */
	utilsModule.clearChildren(errorMsgElem);
	errorMsgContainerElem.getElementsByTagName("a")[0].onclick = function() {
		errorMsgContainerElem.style.display = "none";
		utilsModule.clearChildren(errorMsgElem);
		return false;
	};
	
	/* Exported functions */
	// Appends the given text to the list of error messages, showing the panel if hidden.
	// Types: str is string, result is void.
	this.addMessage = function(str) {
		errorMsgContainerElem.style.removeProperty("display");
		var li = utilsModule.createElementWithText("li", str);
		errorMsgElem.appendChild(li);
	};
};



/*---- Networking functions ----*/

// Called after login (from authenticate()) and after a severe state desynchronization (indirectly from updateState()).
// This performs an Ajax request, changes the page layout, and renders the data on screen.
function getState() {
	var xhr = new XMLHttpRequest();
	xhr.onload = function() {
		var data = JSON.parse(xhr.response);
		if (typeof data != "string") {  // Good data
			windowModule.loadState(data);  // Process data and update UI
			updateState();  // Start polling
		}
	};
	xhr.ontimeout = xhr.onerror = function() {
		var li = utilsModule.createElementWithText("li", "(Unable to connect to data provider)");
		windowListElem.appendChild(li);
	};
	xhr.open("POST", "get-state.json", true);
	xhr.responseType = "text";
	xhr.timeout = 10000;
	xhr.send(JSON.stringify({"maxMessagesPerWindow":maxMessagesPerWindow}));
}


function updateState() {
	var xhr = new XMLHttpRequest();
	xhr.onload = function() {
		if (xhr.status != 200)
			xhr.onerror();
		else {
			var data = JSON.parse(xhr.response);
			if (data != null) {  // Success
				windowModule.loadUpdates(data);
				retryTimeout = 1000;
				updateState();
			} else {  // Lost synchronization or fell behind too much; do full update and re-render text
				setTimeout(getState, retryTimeout);
				if (retryTimeout < 300000)
					retryTimeout *= 2;
			}
		}
	};
	xhr.ontimeout = xhr.onerror = function() {
		setTimeout(updateState, retryTimeout);
		if (retryTimeout < 300000)
			retryTimeout *= 2;
	};
	var maxWait = 60000;
	xhr.open("POST", "get-updates.json", true);
	xhr.responseType = "text";
	xhr.timeout = maxWait + 20000;
	xhr.send(JSON.stringify({"nextUpdateId":nextUpdateId, "maxWait":maxWait}));
}


// Type signature: str path, list<list<val>> payload, func onload/null, func ontimeout/null. Returns nothing.
function sendAction(payload, onerror) {
	var xhr = new XMLHttpRequest();
	if (onerror != null) {
		xhr.onload = function() {
			var data = JSON.parse(xhr.response);
			if (data != "OK")
				onerror(data.toString());
		};
		xhr.ontimeout = function() {
			onerror("Connection timeout");
		};
		xhr.error = function() {
			onerror("Network error");
		};
	}
	xhr.open("POST", "do-actions.json", true);
	xhr.responseType = "text";
	xhr.timeout = 5000;
	xhr.send(JSON.stringify({"payload":payload, "csrfToken":csrfToken, "nextUpdateId":nextUpdateId}));
}


// Type signature: str profile, str target, str text. Returns nothing. The value (profile+"\n"+target) need not exist in windowNames.
function sendMessage(profile, target, text, onerror) {
	sendAction([["send-line", profile, "PRIVMSG " + target + " :" + text]], onerror);
}


function checkTimeSkew() {
	var xhr = new XMLHttpRequest();
	xhr.onload = function() {
		var skew = Date.now() - JSON.parse(xhr.response);
		if (Math.abs(skew) > 10000)
			errorMsgModule.addMessage("Warning: Client time is " + Math.abs(skew / 1000) + " seconds " + (skew > 0 ? "ahead" : "behind") + " server time");
	};
	xhr.open("POST", "get-time.json", true);
	xhr.responseType = "text";
	xhr.send(JSON.stringify(""));
	setTimeout(checkTimeSkew, 100000000);  // About once a day
}



/*---- Miscellaneous ----*/

// This definition exists only for the purpose of abbreviation, because it is used so many times.
// Types: name is string, result is HTMLElement/null.
function elemId(name) {
	return document.getElementById(name);
}


// Polyfill for Apple Safari and Microsoft Internet Explorer.
if (!("startsWith" in String.prototype)) {
	String.prototype.startsWith = function(text, pos) {
		if (pos == undefined)
			pos = 0;
		return this.length - pos >= text.length && this.substr(pos, text.length) == text;
	};
}

// The call to init() must come last due to variables being declared and initialized.
init();

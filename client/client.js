(function(root, factory) {
  // Set up Backbone appropriately for the environment.
  if (typeof exports !== 'undefined') {
    // Node/CommonJS, no need for jQuery in that case.
    factory(exports,require('backbone'),require('underscore'),require('../server/PermissionModel.js').ClientPermissionModel,require('../client/regex.js').REGEXES, require('../server/config.js').Configuration);
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(['underscore', 'backbone', 'PermissionModel', 'regex', 'exports'],
    	function(_, Backbone,PermissionModel,Regex,exports) {
      // Export global even in AMD case in case this script is loaded with
      // others that may still expect a global Backbone.
      return factory(exports, Backbone, _, PermissionModel.PermissionModel, Regex.REGEXES);
    });
  }
})(this,function(exports,Backbone,_, PermissionModel, REGEXES, config) {

	exports.ColorModel = Backbone.Model.extend({
		defaults: {
			r: 0,
			g: 0,
			b: 0
		},
		initialize: function (opts) {
			if (opts) {
				this.set("r", opts.r);
				this.set("g", opts.g);
				this.set("b", opts.b);
			} else {
				var r = parseInt(Math.random()*200+55,10), // push the baseline away from black
					g = parseInt(Math.random()*200+55,10),
					b = parseInt(Math.random()*200+55,10),
					threshold = 50, color = 35;
				//Calculate the manhattan distance to the colors
				//If the colors are within the threshold, invert them
				if (Math.abs(r - color) + Math.abs(g - color) + Math.abs(b - color) <= threshold)
				{
					r = 255 - r;
					g = 255 - g;
					b = 255 - b;
				}
				this.set("r", r);
				this.set("g", g);
				this.set("b", b);
			}
		},
		parse: function (userString, callback) {
			if (userString.match(REGEXES.colors.hex)) {
				this.setFromHex(userString);
				callback(null);
			} else { // only 6-digit hex is supported for now
				callback(new Error("Invalid colour; you must supply a valid CSS hex color code (e.g., '#efefef', '#fff')"));
				return;
			}
		},
		setFromHex: function (hexString) {
			// trim any leading "#"
			if (hexString.charAt(0) === "#") { // strip any leading # symbols
				hexString = hexString.substring(1);
			}
			if (hexString.length === 3) { // e.g. fff -> ffffff
				hexString += hexString;
			}

			var r, g, b;
			r = parseInt(hexString.substring(0,2), 16);
			g = parseInt(hexString.substring(2,4), 16);
			b = parseInt(hexString.substring(4,6), 16);

			this.set({
				r: r,
				g: g,
				b: b
			});
		},
		toRGB: function () {
			return "rgb(" + this.attributes.r + "," + this.attributes.g + "," + this.attributes.b + ")";
		}
	});

	exports.ClientsCollection = Backbone.Collection.extend({
		model: exports.ClientModel
	});

	exports.ClientModel = Backbone.Model.extend({
		supported_metadata: ["email", "website_url", "country_code", "gender"],
		defaults: {
			nick: "Anonymous",
			identified: false,
			idle: false,
			isServer: false,
			authenticated: false,

			email: null,
			country_code: null,
			gender: null,
			website_url: null,
		},
		toJSON: function() {
			var json = Backbone.Model.prototype.toJSON.apply(this, arguments);
  			json.cid = this.cid;
			return json;
		},
		initialize: function (opts) {
			_.bindAll(this);

			if (opts && opts.color) {
				this.set("color", new exports.ColorModel(opts.color));
			} else {
				this.set("color", new exports.ColorModel());
			}
			if (opts && opts.socket) {
				this.socket = opts.socket;
			}

			this.set("permissions", new PermissionModel());
		},
		channelAuth: function (pw, room) {
			$.cookie("channel_pw:" + room, pw, window.COOKIE_OPTIONS);

			this.socket.emit('join_private:' + room, {
				password: pw,
				room: room
			});
		},
		inactive: function (reason, room, socket) {
			reason = reason || "User idle.";

			socket.emit("chat:idle:" + room, {
				reason: reason,
				room: room
			});
			this.set('idle',true);
		},
		active: function (room, socket) {
			if (this.get('idle')) { // only send over wire if we're inactive
				socket.emit("chat:unidle:" + room);
				this.set('idle',false);
			}
		},
		decryptObject: function (encipheredObj, key) {
			if (typeof encipheredObj !== "undefined") {
				var decipheredString, decipheredObj;

				// attempt to decrypt the result:
				try {
					decipheredObj = CryptoJS.AES.decrypt(JSON.stringify(encipheredObj), key, { format: JsonFormatter });
					decipheredString = decipheredObj.toString(CryptoJS.enc.Utf8);
				} catch (e) {
					decipheredString = encipheredObj.ct;
				}

				if (decipheredString === "") {
					decipheredString = encipheredObj.ct;
				}

				return decipheredString;
			} else {
				return "Unknown";
			}
		},
		getNick: function (cryptoKey) {
			var nick = this.get("nick"),
				encrypted_nick = this.get("encrypted_nick");

			if ((typeof cryptoKey !== "undefined") &&
				(cryptoKey !== "") &&
				(typeof encrypted_nick !== "undefined")) {
				nick = this.decryptObject(encrypted_nick, cryptoKey);
			}

			return nick;
		},
		setNick: function (nick, room, ack) {
			var encipheredNick;

			$.cookie("nickname:" + room, nick, window.COOKIE_OPTIONS);

			if (this.cryptokey) {
				var enciphered = CryptoJS.AES.encrypt(nick, this.cryptokey, { format: JsonFormatter });
				nick = "-";
				encipheredNick = JSON.parse(enciphered.toString());
				this.set("encrypted_nick", encipheredNick);
			}

			this.set("nick", nick);
			this.socket.emit('nickname:' + room, {
				nick: nick,
				encrypted: encipheredNick
			}, function () {
				if (ack) {
					ack.resolve();
				}
			});
		},
		identify: function (pw, room, ack) {
			$.cookie("ident_pw:" + room, pw, window.COOKIE_OPTIONS);
			this.socket.emit('identify:' + room, {
				password: pw,
				room: room
			}, function () {
				ack.resolve();
			});
		},
		is: function (cid) {
			return (this.cid === cid);
		},
		speak: function (msg, socket) {
			var body = msg.body,
				room = msg.room,
				matches;
			window.events.trigger("speak",socket,this,msg);
			if (!body) return; // if there's no body, we probably don't want to do anything
			if (body.match(REGEXES.commands.nick)) { // /nick [nickname]
				body = body.replace(REGEXES.commands.nick, "").trim();
				this.setNick(body, room);
				$.cookie("nickname:" + room, body, window.COOKIE_OPTIONS);
				$.removeCookie("ident_pw:" + room, window.COOKIE_OPTIONS); // clear out the old saved nick
				return;
			} else if (body.match(REGEXES.commands.private)) {  // /private [password]
				body = body.replace(REGEXES.commands.private, "").trim();
				socket.emit('make_private:' + room, {
					password: body,
					room: room
				});
				$.cookie("channel_pw:" + room, body, window.COOKIE_OPTIONS);
				return;
			} else if (body.match(REGEXES.commands.public)) {  // /public
				body = body.replace(REGEXES.commands.public, "").trim();
				socket.emit('make_public:' + room, {
					room: room
				});
				return;
			} else if (body.match(REGEXES.commands.password)) {  // /password [password]
				body = body.replace(REGEXES.commands.password, "").trim();
				this.channelAuth(body, room);
				return;
			} else if (body.match(REGEXES.commands.register)) {  // /register [password]
				body = body.replace(REGEXES.commands.register, "").trim();
				socket.emit('register_nick:' + room, {
					password: body,
					room: room
				});
				$.cookie("ident_pw:" + room, body, window.COOKIE_OPTIONS);
				return;
			} else if (body.match(REGEXES.commands.identify)) { // /identify [password]
				body = body.replace(REGEXES.commands.identify, "").trim();
				this.identify(body, room);
				return;
			} else if (body.match(REGEXES.commands.topic)) { // /topic [My channel topic]
				body = body.replace(REGEXES.commands.topic, "").trim();
				socket.emit('topic:' + room, {
					topic: body,
					room: room
				});
				return;
			} else if (body.match(REGEXES.commands.private_message)) { // /tell [nick] [message]
				body = body.replace(REGEXES.commands.private_message, "").trim();

				var targetNick = body.split(" "); // take the first token to mean the

				if (targetNick.length) {
					targetNick = targetNick[0];
					body = body.replace(targetNick, "").trim();
					if (targetNick.charAt(0) === "@") { // remove the leading "@" symbol; TODO: validate username characters not to include special symbols
						targetNick = targetNick.substring(1);
					}

					socket.emit('private_message:' + room, {
						body: body,
						room: room,
						directedAt: targetNick
					});
				}
				return;
			} else if (body.match(REGEXES.commands.pull_logs)) { // pull
				body = body.replace(REGEXES.commands.pull_logs, "").trim();

				if (body === "ALL") {
					console.warn("/pull all -- Not implemented yet");
				} else {
					var nLogs = Math.max(1, parseInt(body, 10));
						nLogs = Math.min(100, nLogs), // 1 <= N <= 100
						missed = this.persistentLog.getMissingIDs(nLogs);

					if (missed.length) {
						this.socket.emit("chat:history_request:" + room, {
						 	requestRange: missed
						});
					}
				}
				return;
			} else if (body.match(REGEXES.commands.set_color)) { // pull
				body = body.replace(REGEXES.commands.set_color, "").trim();

				socket.emit('user:set_color:' + room, {
					userColorString: body
				});
				return;
			} else if (matches = body.match(REGEXES.commands.edit)) { // editing
				var mID = matches[2], data;

				body = body.replace(REGEXES.commands.edit, "").trim();

				data = {
					mID: mID,
					body: body,
				};

				if (this.cryptokey) {
					var enciphered = CryptoJS.AES.encrypt(data.body, this.cryptokey, { format: JsonFormatter });
					data.body = "-";
					data.encrypted = JSON.parse(enciphered.toString());
				}

				socket.emit('chat:edit:' + room, data);

				return;
			} else if (body.match(REGEXES.commands.leave)) { // leaving
				window.events.trigger('leave:' + room);
				return;
			} else if (body.match(REGEXES.commands.chown)) { // become owner
				body = body.replace(REGEXES.commands.chown, "").trim();
				socket.emit('chown:' + room, {
					key: body
				});
				return;
			} else if (body.match(REGEXES.commands.chmod)) { // change permissions
				body = body.replace(REGEXES.commands.chmod, "").trim();
				socket.emit('chmod:' + room, {
					body: body
				});
			} else if (body.match(REGEXES.commands.broadcast)) { // broadcast to speak to all open channels at once
				body = body.replace(REGEXES.commands.broadcast, "").trim();
				window.events.trigger('chat:broadcast', {
					body: body
				});
				return;
			} else if (body.match(REGEXES.commands.failed_command)) { // match all
				return;
			} else { // send it out to the world!

				if (this.cryptokey) {
					var enciphered = CryptoJS.AES.encrypt(msg.body, this.cryptokey, { format: JsonFormatter });
					msg.body = "-";
					msg.encrypted = JSON.parse(enciphered.toString());
				}
				socket.emit('chat:' + room, msg);
			}
		}
	});

});

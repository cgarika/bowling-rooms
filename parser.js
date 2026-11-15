/* The wire parser: socket.io-parser's own, byte for byte, without two costs this server paid for nothing (measured:
   15% of the event loop's busy time at 100 rooms went to the first).
   - hasBinary: the stock encoder walks every emitted payload looking for Buffers before it encodes. Nothing here sends
     binary (the app speaks JSON only: GameNestSocket.cpp), so the walk is skipped. A Buffer that did get into a
     payload would be written as JSON ({"type":"Buffer","data":[...]}), never as a binary attachment.
   - the state: sendState emits the same room object to every socket in a room, with only mySeat different. Its JSON
     is made once per state (a WeakMap keyed by the room object) and each socket's frame is spliced from it.
   test/protocol.js checks the frames against the stock encoder's, byte for byte. */
"use strict";
const base = require("socket.io-parser");
const roomJson = new WeakMap();

class Encoder extends base.Encoder {
  encode(obj) { return [this.encodeAsString(obj)]; }
  encodeAsString(obj) {
    const d = obj.data;
    if (obj.type === base.PacketType.EVENT && !this.replacer && Array.isArray(d) && d.length === 2 && d[0] === "state" && d[1] && typeof d[1] === "object") {
      const env = d[1], keys = Object.keys(env);
      if (keys.length === 2 && keys[0] === "room" && keys[1] === "mySeat" && env.room && typeof env.room === "object" && Number.isInteger(env.mySeat)) {
        let json = roomJson.get(env.room);
        if (json === undefined) { json = JSON.stringify(env.room); roomJson.set(env.room, json); }
        let str = "" + obj.type;
        if (obj.nsp && obj.nsp !== "/") str += obj.nsp + ",";
        if (obj.id != null) str += obj.id;
        return str + '["state",{"room":' + json + ',"mySeat":' + env.mySeat + "}]";
      }
    }
    return super.encodeAsString(obj);
  }
}

module.exports = { protocol: base.protocol, PacketType: base.PacketType, Decoder: base.Decoder, isPacketValid: base.isPacketValid, Encoder };

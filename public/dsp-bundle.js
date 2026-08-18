"use strict";
var SynthModemDSP = (() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __commonJS = (cb, mod) => function __require2() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // node_modules/base64-js/index.js
  var require_base64_js = __commonJS({
    "node_modules/base64-js/index.js"(exports) {
      "use strict";
      exports.byteLength = byteLength;
      exports.toByteArray = toByteArray;
      exports.fromByteArray = fromByteArray;
      var lookup = [];
      var revLookup = [];
      var Arr = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
      var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      for (i = 0, len = code.length; i < len; ++i) {
        lookup[i] = code[i];
        revLookup[code.charCodeAt(i)] = i;
      }
      var i;
      var len;
      revLookup["-".charCodeAt(0)] = 62;
      revLookup["_".charCodeAt(0)] = 63;
      function getLens(b64) {
        var len2 = b64.length;
        if (len2 % 4 > 0) {
          throw new Error("Invalid string. Length must be a multiple of 4");
        }
        var validLen = b64.indexOf("=");
        if (validLen === -1) validLen = len2;
        var placeHoldersLen = validLen === len2 ? 0 : 4 - validLen % 4;
        return [validLen, placeHoldersLen];
      }
      function byteLength(b64) {
        var lens = getLens(b64);
        var validLen = lens[0];
        var placeHoldersLen = lens[1];
        return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
      }
      function _byteLength(b64, validLen, placeHoldersLen) {
        return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
      }
      function toByteArray(b64) {
        var tmp;
        var lens = getLens(b64);
        var validLen = lens[0];
        var placeHoldersLen = lens[1];
        var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));
        var curByte = 0;
        var len2 = placeHoldersLen > 0 ? validLen - 4 : validLen;
        var i2;
        for (i2 = 0; i2 < len2; i2 += 4) {
          tmp = revLookup[b64.charCodeAt(i2)] << 18 | revLookup[b64.charCodeAt(i2 + 1)] << 12 | revLookup[b64.charCodeAt(i2 + 2)] << 6 | revLookup[b64.charCodeAt(i2 + 3)];
          arr[curByte++] = tmp >> 16 & 255;
          arr[curByte++] = tmp >> 8 & 255;
          arr[curByte++] = tmp & 255;
        }
        if (placeHoldersLen === 2) {
          tmp = revLookup[b64.charCodeAt(i2)] << 2 | revLookup[b64.charCodeAt(i2 + 1)] >> 4;
          arr[curByte++] = tmp & 255;
        }
        if (placeHoldersLen === 1) {
          tmp = revLookup[b64.charCodeAt(i2)] << 10 | revLookup[b64.charCodeAt(i2 + 1)] << 4 | revLookup[b64.charCodeAt(i2 + 2)] >> 2;
          arr[curByte++] = tmp >> 8 & 255;
          arr[curByte++] = tmp & 255;
        }
        return arr;
      }
      function tripletToBase64(num) {
        return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
      }
      function encodeChunk(uint8, start, end) {
        var tmp;
        var output = [];
        for (var i2 = start; i2 < end; i2 += 3) {
          tmp = (uint8[i2] << 16 & 16711680) + (uint8[i2 + 1] << 8 & 65280) + (uint8[i2 + 2] & 255);
          output.push(tripletToBase64(tmp));
        }
        return output.join("");
      }
      function fromByteArray(uint8) {
        var tmp;
        var len2 = uint8.length;
        var extraBytes = len2 % 3;
        var parts = [];
        var maxChunkLength = 16383;
        for (var i2 = 0, len22 = len2 - extraBytes; i2 < len22; i2 += maxChunkLength) {
          parts.push(encodeChunk(uint8, i2, i2 + maxChunkLength > len22 ? len22 : i2 + maxChunkLength));
        }
        if (extraBytes === 1) {
          tmp = uint8[len2 - 1];
          parts.push(
            lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "=="
          );
        } else if (extraBytes === 2) {
          tmp = (uint8[len2 - 2] << 8) + uint8[len2 - 1];
          parts.push(
            lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "="
          );
        }
        return parts.join("");
      }
    }
  });

  // node_modules/ieee754/index.js
  var require_ieee754 = __commonJS({
    "node_modules/ieee754/index.js"(exports) {
      exports.read = function(buffer, offset, isLE, mLen, nBytes) {
        var e, m;
        var eLen = nBytes * 8 - mLen - 1;
        var eMax = (1 << eLen) - 1;
        var eBias = eMax >> 1;
        var nBits = -7;
        var i = isLE ? nBytes - 1 : 0;
        var d = isLE ? -1 : 1;
        var s = buffer[offset + i];
        i += d;
        e = s & (1 << -nBits) - 1;
        s >>= -nBits;
        nBits += eLen;
        for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {
        }
        m = e & (1 << -nBits) - 1;
        e >>= -nBits;
        nBits += mLen;
        for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {
        }
        if (e === 0) {
          e = 1 - eBias;
        } else if (e === eMax) {
          return m ? NaN : (s ? -1 : 1) * Infinity;
        } else {
          m = m + Math.pow(2, mLen);
          e = e - eBias;
        }
        return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
      };
      exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
        var e, m, c;
        var eLen = nBytes * 8 - mLen - 1;
        var eMax = (1 << eLen) - 1;
        var eBias = eMax >> 1;
        var rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0;
        var i = isLE ? 0 : nBytes - 1;
        var d = isLE ? 1 : -1;
        var s = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
        value = Math.abs(value);
        if (isNaN(value) || value === Infinity) {
          m = isNaN(value) ? 1 : 0;
          e = eMax;
        } else {
          e = Math.floor(Math.log(value) / Math.LN2);
          if (value * (c = Math.pow(2, -e)) < 1) {
            e--;
            c *= 2;
          }
          if (e + eBias >= 1) {
            value += rt / c;
          } else {
            value += rt * Math.pow(2, 1 - eBias);
          }
          if (value * c >= 2) {
            e++;
            c /= 2;
          }
          if (e + eBias >= eMax) {
            m = 0;
            e = eMax;
          } else if (e + eBias >= 1) {
            m = (value * c - 1) * Math.pow(2, mLen);
            e = e + eBias;
          } else {
            m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
            e = 0;
          }
        }
        for (; mLen >= 8; buffer[offset + i] = m & 255, i += d, m /= 256, mLen -= 8) {
        }
        e = e << mLen | m;
        eLen += mLen;
        for (; eLen > 0; buffer[offset + i] = e & 255, i += d, e /= 256, eLen -= 8) {
        }
        buffer[offset + i - d] |= s * 128;
      };
    }
  });

  // node_modules/buffer/index.js
  var require_buffer = __commonJS({
    "node_modules/buffer/index.js"(exports) {
      "use strict";
      var base64 = require_base64_js();
      var ieee754 = require_ieee754();
      var customInspectSymbol = typeof Symbol === "function" && typeof Symbol["for"] === "function" ? Symbol["for"]("nodejs.util.inspect.custom") : null;
      exports.Buffer = Buffer2;
      exports.SlowBuffer = SlowBuffer;
      exports.INSPECT_MAX_BYTES = 50;
      var K_MAX_LENGTH = 2147483647;
      exports.kMaxLength = K_MAX_LENGTH;
      Buffer2.TYPED_ARRAY_SUPPORT = typedArraySupport();
      if (!Buffer2.TYPED_ARRAY_SUPPORT && typeof console !== "undefined" && typeof console.error === "function") {
        console.error(
          "This browser lacks typed array (Uint8Array) support which is required by `buffer` v5.x. Use `buffer` v4.x if you require old browser support."
        );
      }
      function typedArraySupport() {
        try {
          const arr = new Uint8Array(1);
          const proto = { foo: function() {
            return 42;
          } };
          Object.setPrototypeOf(proto, Uint8Array.prototype);
          Object.setPrototypeOf(arr, proto);
          return arr.foo() === 42;
        } catch (e) {
          return false;
        }
      }
      Object.defineProperty(Buffer2.prototype, "parent", {
        enumerable: true,
        get: function() {
          if (!Buffer2.isBuffer(this)) return void 0;
          return this.buffer;
        }
      });
      Object.defineProperty(Buffer2.prototype, "offset", {
        enumerable: true,
        get: function() {
          if (!Buffer2.isBuffer(this)) return void 0;
          return this.byteOffset;
        }
      });
      function createBuffer(length) {
        if (length > K_MAX_LENGTH) {
          throw new RangeError('The value "' + length + '" is invalid for option "size"');
        }
        const buf = new Uint8Array(length);
        Object.setPrototypeOf(buf, Buffer2.prototype);
        return buf;
      }
      function Buffer2(arg, encodingOrOffset, length) {
        if (typeof arg === "number") {
          if (typeof encodingOrOffset === "string") {
            throw new TypeError(
              'The "string" argument must be of type string. Received type number'
            );
          }
          return allocUnsafe(arg);
        }
        return from(arg, encodingOrOffset, length);
      }
      Buffer2.poolSize = 8192;
      function from(value, encodingOrOffset, length) {
        if (typeof value === "string") {
          return fromString(value, encodingOrOffset);
        }
        if (ArrayBuffer.isView(value)) {
          return fromArrayView(value);
        }
        if (value == null) {
          throw new TypeError(
            "The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value
          );
        }
        if (isInstance(value, ArrayBuffer) || value && isInstance(value.buffer, ArrayBuffer)) {
          return fromArrayBuffer(value, encodingOrOffset, length);
        }
        if (typeof SharedArrayBuffer !== "undefined" && (isInstance(value, SharedArrayBuffer) || value && isInstance(value.buffer, SharedArrayBuffer))) {
          return fromArrayBuffer(value, encodingOrOffset, length);
        }
        if (typeof value === "number") {
          throw new TypeError(
            'The "value" argument must not be of type number. Received type number'
          );
        }
        const valueOf = value.valueOf && value.valueOf();
        if (valueOf != null && valueOf !== value) {
          return Buffer2.from(valueOf, encodingOrOffset, length);
        }
        const b = fromObject(value);
        if (b) return b;
        if (typeof Symbol !== "undefined" && Symbol.toPrimitive != null && typeof value[Symbol.toPrimitive] === "function") {
          return Buffer2.from(value[Symbol.toPrimitive]("string"), encodingOrOffset, length);
        }
        throw new TypeError(
          "The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value
        );
      }
      Buffer2.from = function(value, encodingOrOffset, length) {
        return from(value, encodingOrOffset, length);
      };
      Object.setPrototypeOf(Buffer2.prototype, Uint8Array.prototype);
      Object.setPrototypeOf(Buffer2, Uint8Array);
      function assertSize(size) {
        if (typeof size !== "number") {
          throw new TypeError('"size" argument must be of type number');
        } else if (size < 0) {
          throw new RangeError('The value "' + size + '" is invalid for option "size"');
        }
      }
      function alloc(size, fill, encoding) {
        assertSize(size);
        if (size <= 0) {
          return createBuffer(size);
        }
        if (fill !== void 0) {
          return typeof encoding === "string" ? createBuffer(size).fill(fill, encoding) : createBuffer(size).fill(fill);
        }
        return createBuffer(size);
      }
      Buffer2.alloc = function(size, fill, encoding) {
        return alloc(size, fill, encoding);
      };
      function allocUnsafe(size) {
        assertSize(size);
        return createBuffer(size < 0 ? 0 : checked(size) | 0);
      }
      Buffer2.allocUnsafe = function(size) {
        return allocUnsafe(size);
      };
      Buffer2.allocUnsafeSlow = function(size) {
        return allocUnsafe(size);
      };
      function fromString(string, encoding) {
        if (typeof encoding !== "string" || encoding === "") {
          encoding = "utf8";
        }
        if (!Buffer2.isEncoding(encoding)) {
          throw new TypeError("Unknown encoding: " + encoding);
        }
        const length = byteLength(string, encoding) | 0;
        let buf = createBuffer(length);
        const actual = buf.write(string, encoding);
        if (actual !== length) {
          buf = buf.slice(0, actual);
        }
        return buf;
      }
      function fromArrayLike(array) {
        const length = array.length < 0 ? 0 : checked(array.length) | 0;
        const buf = createBuffer(length);
        for (let i = 0; i < length; i += 1) {
          buf[i] = array[i] & 255;
        }
        return buf;
      }
      function fromArrayView(arrayView) {
        if (isInstance(arrayView, Uint8Array)) {
          const copy = new Uint8Array(arrayView);
          return fromArrayBuffer(copy.buffer, copy.byteOffset, copy.byteLength);
        }
        return fromArrayLike(arrayView);
      }
      function fromArrayBuffer(array, byteOffset, length) {
        if (byteOffset < 0 || array.byteLength < byteOffset) {
          throw new RangeError('"offset" is outside of buffer bounds');
        }
        if (array.byteLength < byteOffset + (length || 0)) {
          throw new RangeError('"length" is outside of buffer bounds');
        }
        let buf;
        if (byteOffset === void 0 && length === void 0) {
          buf = new Uint8Array(array);
        } else if (length === void 0) {
          buf = new Uint8Array(array, byteOffset);
        } else {
          buf = new Uint8Array(array, byteOffset, length);
        }
        Object.setPrototypeOf(buf, Buffer2.prototype);
        return buf;
      }
      function fromObject(obj) {
        if (Buffer2.isBuffer(obj)) {
          const len = checked(obj.length) | 0;
          const buf = createBuffer(len);
          if (buf.length === 0) {
            return buf;
          }
          obj.copy(buf, 0, 0, len);
          return buf;
        }
        if (obj.length !== void 0) {
          if (typeof obj.length !== "number" || numberIsNaN(obj.length)) {
            return createBuffer(0);
          }
          return fromArrayLike(obj);
        }
        if (obj.type === "Buffer" && Array.isArray(obj.data)) {
          return fromArrayLike(obj.data);
        }
      }
      function checked(length) {
        if (length >= K_MAX_LENGTH) {
          throw new RangeError("Attempt to allocate Buffer larger than maximum size: 0x" + K_MAX_LENGTH.toString(16) + " bytes");
        }
        return length | 0;
      }
      function SlowBuffer(length) {
        if (+length != length) {
          length = 0;
        }
        return Buffer2.alloc(+length);
      }
      Buffer2.isBuffer = function isBuffer(b) {
        return b != null && b._isBuffer === true && b !== Buffer2.prototype;
      };
      Buffer2.compare = function compare(a, b) {
        if (isInstance(a, Uint8Array)) a = Buffer2.from(a, a.offset, a.byteLength);
        if (isInstance(b, Uint8Array)) b = Buffer2.from(b, b.offset, b.byteLength);
        if (!Buffer2.isBuffer(a) || !Buffer2.isBuffer(b)) {
          throw new TypeError(
            'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
          );
        }
        if (a === b) return 0;
        let x = a.length;
        let y = b.length;
        for (let i = 0, len = Math.min(x, y); i < len; ++i) {
          if (a[i] !== b[i]) {
            x = a[i];
            y = b[i];
            break;
          }
        }
        if (x < y) return -1;
        if (y < x) return 1;
        return 0;
      };
      Buffer2.isEncoding = function isEncoding(encoding) {
        switch (String(encoding).toLowerCase()) {
          case "hex":
          case "utf8":
          case "utf-8":
          case "ascii":
          case "latin1":
          case "binary":
          case "base64":
          case "ucs2":
          case "ucs-2":
          case "utf16le":
          case "utf-16le":
            return true;
          default:
            return false;
        }
      };
      Buffer2.concat = function concat(list, length) {
        if (!Array.isArray(list)) {
          throw new TypeError('"list" argument must be an Array of Buffers');
        }
        if (list.length === 0) {
          return Buffer2.alloc(0);
        }
        let i;
        if (length === void 0) {
          length = 0;
          for (i = 0; i < list.length; ++i) {
            length += list[i].length;
          }
        }
        const buffer = Buffer2.allocUnsafe(length);
        let pos = 0;
        for (i = 0; i < list.length; ++i) {
          let buf = list[i];
          if (isInstance(buf, Uint8Array)) {
            if (pos + buf.length > buffer.length) {
              if (!Buffer2.isBuffer(buf)) buf = Buffer2.from(buf);
              buf.copy(buffer, pos);
            } else {
              Uint8Array.prototype.set.call(
                buffer,
                buf,
                pos
              );
            }
          } else if (!Buffer2.isBuffer(buf)) {
            throw new TypeError('"list" argument must be an Array of Buffers');
          } else {
            buf.copy(buffer, pos);
          }
          pos += buf.length;
        }
        return buffer;
      };
      function byteLength(string, encoding) {
        if (Buffer2.isBuffer(string)) {
          return string.length;
        }
        if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
          return string.byteLength;
        }
        if (typeof string !== "string") {
          throw new TypeError(
            'The "string" argument must be one of type string, Buffer, or ArrayBuffer. Received type ' + typeof string
          );
        }
        const len = string.length;
        const mustMatch = arguments.length > 2 && arguments[2] === true;
        if (!mustMatch && len === 0) return 0;
        let loweredCase = false;
        for (; ; ) {
          switch (encoding) {
            case "ascii":
            case "latin1":
            case "binary":
              return len;
            case "utf8":
            case "utf-8":
              return utf8ToBytes(string).length;
            case "ucs2":
            case "ucs-2":
            case "utf16le":
            case "utf-16le":
              return len * 2;
            case "hex":
              return len >>> 1;
            case "base64":
              return base64ToBytes(string).length;
            default:
              if (loweredCase) {
                return mustMatch ? -1 : utf8ToBytes(string).length;
              }
              encoding = ("" + encoding).toLowerCase();
              loweredCase = true;
          }
        }
      }
      Buffer2.byteLength = byteLength;
      function slowToString(encoding, start, end) {
        let loweredCase = false;
        if (start === void 0 || start < 0) {
          start = 0;
        }
        if (start > this.length) {
          return "";
        }
        if (end === void 0 || end > this.length) {
          end = this.length;
        }
        if (end <= 0) {
          return "";
        }
        end >>>= 0;
        start >>>= 0;
        if (end <= start) {
          return "";
        }
        if (!encoding) encoding = "utf8";
        while (true) {
          switch (encoding) {
            case "hex":
              return hexSlice(this, start, end);
            case "utf8":
            case "utf-8":
              return utf8Slice(this, start, end);
            case "ascii":
              return asciiSlice(this, start, end);
            case "latin1":
            case "binary":
              return latin1Slice(this, start, end);
            case "base64":
              return base64Slice(this, start, end);
            case "ucs2":
            case "ucs-2":
            case "utf16le":
            case "utf-16le":
              return utf16leSlice(this, start, end);
            default:
              if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
              encoding = (encoding + "").toLowerCase();
              loweredCase = true;
          }
        }
      }
      Buffer2.prototype._isBuffer = true;
      function swap(b, n, m) {
        const i = b[n];
        b[n] = b[m];
        b[m] = i;
      }
      Buffer2.prototype.swap16 = function swap16() {
        const len = this.length;
        if (len % 2 !== 0) {
          throw new RangeError("Buffer size must be a multiple of 16-bits");
        }
        for (let i = 0; i < len; i += 2) {
          swap(this, i, i + 1);
        }
        return this;
      };
      Buffer2.prototype.swap32 = function swap32() {
        const len = this.length;
        if (len % 4 !== 0) {
          throw new RangeError("Buffer size must be a multiple of 32-bits");
        }
        for (let i = 0; i < len; i += 4) {
          swap(this, i, i + 3);
          swap(this, i + 1, i + 2);
        }
        return this;
      };
      Buffer2.prototype.swap64 = function swap64() {
        const len = this.length;
        if (len % 8 !== 0) {
          throw new RangeError("Buffer size must be a multiple of 64-bits");
        }
        for (let i = 0; i < len; i += 8) {
          swap(this, i, i + 7);
          swap(this, i + 1, i + 6);
          swap(this, i + 2, i + 5);
          swap(this, i + 3, i + 4);
        }
        return this;
      };
      Buffer2.prototype.toString = function toString() {
        const length = this.length;
        if (length === 0) return "";
        if (arguments.length === 0) return utf8Slice(this, 0, length);
        return slowToString.apply(this, arguments);
      };
      Buffer2.prototype.toLocaleString = Buffer2.prototype.toString;
      Buffer2.prototype.equals = function equals(b) {
        if (!Buffer2.isBuffer(b)) throw new TypeError("Argument must be a Buffer");
        if (this === b) return true;
        return Buffer2.compare(this, b) === 0;
      };
      Buffer2.prototype.inspect = function inspect() {
        let str = "";
        const max = exports.INSPECT_MAX_BYTES;
        str = this.toString("hex", 0, max).replace(/(.{2})/g, "$1 ").trim();
        if (this.length > max) str += " ... ";
        return "<Buffer " + str + ">";
      };
      if (customInspectSymbol) {
        Buffer2.prototype[customInspectSymbol] = Buffer2.prototype.inspect;
      }
      Buffer2.prototype.compare = function compare(target, start, end, thisStart, thisEnd) {
        if (isInstance(target, Uint8Array)) {
          target = Buffer2.from(target, target.offset, target.byteLength);
        }
        if (!Buffer2.isBuffer(target)) {
          throw new TypeError(
            'The "target" argument must be one of type Buffer or Uint8Array. Received type ' + typeof target
          );
        }
        if (start === void 0) {
          start = 0;
        }
        if (end === void 0) {
          end = target ? target.length : 0;
        }
        if (thisStart === void 0) {
          thisStart = 0;
        }
        if (thisEnd === void 0) {
          thisEnd = this.length;
        }
        if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
          throw new RangeError("out of range index");
        }
        if (thisStart >= thisEnd && start >= end) {
          return 0;
        }
        if (thisStart >= thisEnd) {
          return -1;
        }
        if (start >= end) {
          return 1;
        }
        start >>>= 0;
        end >>>= 0;
        thisStart >>>= 0;
        thisEnd >>>= 0;
        if (this === target) return 0;
        let x = thisEnd - thisStart;
        let y = end - start;
        const len = Math.min(x, y);
        const thisCopy = this.slice(thisStart, thisEnd);
        const targetCopy = target.slice(start, end);
        for (let i = 0; i < len; ++i) {
          if (thisCopy[i] !== targetCopy[i]) {
            x = thisCopy[i];
            y = targetCopy[i];
            break;
          }
        }
        if (x < y) return -1;
        if (y < x) return 1;
        return 0;
      };
      function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
        if (buffer.length === 0) return -1;
        if (typeof byteOffset === "string") {
          encoding = byteOffset;
          byteOffset = 0;
        } else if (byteOffset > 2147483647) {
          byteOffset = 2147483647;
        } else if (byteOffset < -2147483648) {
          byteOffset = -2147483648;
        }
        byteOffset = +byteOffset;
        if (numberIsNaN(byteOffset)) {
          byteOffset = dir ? 0 : buffer.length - 1;
        }
        if (byteOffset < 0) byteOffset = buffer.length + byteOffset;
        if (byteOffset >= buffer.length) {
          if (dir) return -1;
          else byteOffset = buffer.length - 1;
        } else if (byteOffset < 0) {
          if (dir) byteOffset = 0;
          else return -1;
        }
        if (typeof val === "string") {
          val = Buffer2.from(val, encoding);
        }
        if (Buffer2.isBuffer(val)) {
          if (val.length === 0) {
            return -1;
          }
          return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
        } else if (typeof val === "number") {
          val = val & 255;
          if (typeof Uint8Array.prototype.indexOf === "function") {
            if (dir) {
              return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
            } else {
              return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
            }
          }
          return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
        }
        throw new TypeError("val must be string, number or Buffer");
      }
      function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
        let indexSize = 1;
        let arrLength = arr.length;
        let valLength = val.length;
        if (encoding !== void 0) {
          encoding = String(encoding).toLowerCase();
          if (encoding === "ucs2" || encoding === "ucs-2" || encoding === "utf16le" || encoding === "utf-16le") {
            if (arr.length < 2 || val.length < 2) {
              return -1;
            }
            indexSize = 2;
            arrLength /= 2;
            valLength /= 2;
            byteOffset /= 2;
          }
        }
        function read(buf, i2) {
          if (indexSize === 1) {
            return buf[i2];
          } else {
            return buf.readUInt16BE(i2 * indexSize);
          }
        }
        let i;
        if (dir) {
          let foundIndex = -1;
          for (i = byteOffset; i < arrLength; i++) {
            if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
              if (foundIndex === -1) foundIndex = i;
              if (i - foundIndex + 1 === valLength) return foundIndex * indexSize;
            } else {
              if (foundIndex !== -1) i -= i - foundIndex;
              foundIndex = -1;
            }
          }
        } else {
          if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength;
          for (i = byteOffset; i >= 0; i--) {
            let found = true;
            for (let j = 0; j < valLength; j++) {
              if (read(arr, i + j) !== read(val, j)) {
                found = false;
                break;
              }
            }
            if (found) return i;
          }
        }
        return -1;
      }
      Buffer2.prototype.includes = function includes(val, byteOffset, encoding) {
        return this.indexOf(val, byteOffset, encoding) !== -1;
      };
      Buffer2.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
        return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
      };
      Buffer2.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
        return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
      };
      function hexWrite(buf, string, offset, length) {
        offset = Number(offset) || 0;
        const remaining = buf.length - offset;
        if (!length) {
          length = remaining;
        } else {
          length = Number(length);
          if (length > remaining) {
            length = remaining;
          }
        }
        const strLen = string.length;
        if (length > strLen / 2) {
          length = strLen / 2;
        }
        let i;
        for (i = 0; i < length; ++i) {
          const parsed = parseInt(string.substr(i * 2, 2), 16);
          if (numberIsNaN(parsed)) return i;
          buf[offset + i] = parsed;
        }
        return i;
      }
      function utf8Write(buf, string, offset, length) {
        return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
      }
      function asciiWrite(buf, string, offset, length) {
        return blitBuffer(asciiToBytes(string), buf, offset, length);
      }
      function base64Write(buf, string, offset, length) {
        return blitBuffer(base64ToBytes(string), buf, offset, length);
      }
      function ucs2Write(buf, string, offset, length) {
        return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
      }
      Buffer2.prototype.write = function write(string, offset, length, encoding) {
        if (offset === void 0) {
          encoding = "utf8";
          length = this.length;
          offset = 0;
        } else if (length === void 0 && typeof offset === "string") {
          encoding = offset;
          length = this.length;
          offset = 0;
        } else if (isFinite(offset)) {
          offset = offset >>> 0;
          if (isFinite(length)) {
            length = length >>> 0;
            if (encoding === void 0) encoding = "utf8";
          } else {
            encoding = length;
            length = void 0;
          }
        } else {
          throw new Error(
            "Buffer.write(string, encoding, offset[, length]) is no longer supported"
          );
        }
        const remaining = this.length - offset;
        if (length === void 0 || length > remaining) length = remaining;
        if (string.length > 0 && (length < 0 || offset < 0) || offset > this.length) {
          throw new RangeError("Attempt to write outside buffer bounds");
        }
        if (!encoding) encoding = "utf8";
        let loweredCase = false;
        for (; ; ) {
          switch (encoding) {
            case "hex":
              return hexWrite(this, string, offset, length);
            case "utf8":
            case "utf-8":
              return utf8Write(this, string, offset, length);
            case "ascii":
            case "latin1":
            case "binary":
              return asciiWrite(this, string, offset, length);
            case "base64":
              return base64Write(this, string, offset, length);
            case "ucs2":
            case "ucs-2":
            case "utf16le":
            case "utf-16le":
              return ucs2Write(this, string, offset, length);
            default:
              if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
              encoding = ("" + encoding).toLowerCase();
              loweredCase = true;
          }
        }
      };
      Buffer2.prototype.toJSON = function toJSON() {
        return {
          type: "Buffer",
          data: Array.prototype.slice.call(this._arr || this, 0)
        };
      };
      function base64Slice(buf, start, end) {
        if (start === 0 && end === buf.length) {
          return base64.fromByteArray(buf);
        } else {
          return base64.fromByteArray(buf.slice(start, end));
        }
      }
      function utf8Slice(buf, start, end) {
        end = Math.min(buf.length, end);
        const res = [];
        let i = start;
        while (i < end) {
          const firstByte = buf[i];
          let codePoint = null;
          let bytesPerSequence = firstByte > 239 ? 4 : firstByte > 223 ? 3 : firstByte > 191 ? 2 : 1;
          if (i + bytesPerSequence <= end) {
            let secondByte, thirdByte, fourthByte, tempCodePoint;
            switch (bytesPerSequence) {
              case 1:
                if (firstByte < 128) {
                  codePoint = firstByte;
                }
                break;
              case 2:
                secondByte = buf[i + 1];
                if ((secondByte & 192) === 128) {
                  tempCodePoint = (firstByte & 31) << 6 | secondByte & 63;
                  if (tempCodePoint > 127) {
                    codePoint = tempCodePoint;
                  }
                }
                break;
              case 3:
                secondByte = buf[i + 1];
                thirdByte = buf[i + 2];
                if ((secondByte & 192) === 128 && (thirdByte & 192) === 128) {
                  tempCodePoint = (firstByte & 15) << 12 | (secondByte & 63) << 6 | thirdByte & 63;
                  if (tempCodePoint > 2047 && (tempCodePoint < 55296 || tempCodePoint > 57343)) {
                    codePoint = tempCodePoint;
                  }
                }
                break;
              case 4:
                secondByte = buf[i + 1];
                thirdByte = buf[i + 2];
                fourthByte = buf[i + 3];
                if ((secondByte & 192) === 128 && (thirdByte & 192) === 128 && (fourthByte & 192) === 128) {
                  tempCodePoint = (firstByte & 15) << 18 | (secondByte & 63) << 12 | (thirdByte & 63) << 6 | fourthByte & 63;
                  if (tempCodePoint > 65535 && tempCodePoint < 1114112) {
                    codePoint = tempCodePoint;
                  }
                }
            }
          }
          if (codePoint === null) {
            codePoint = 65533;
            bytesPerSequence = 1;
          } else if (codePoint > 65535) {
            codePoint -= 65536;
            res.push(codePoint >>> 10 & 1023 | 55296);
            codePoint = 56320 | codePoint & 1023;
          }
          res.push(codePoint);
          i += bytesPerSequence;
        }
        return decodeCodePointsArray(res);
      }
      var MAX_ARGUMENTS_LENGTH = 4096;
      function decodeCodePointsArray(codePoints) {
        const len = codePoints.length;
        if (len <= MAX_ARGUMENTS_LENGTH) {
          return String.fromCharCode.apply(String, codePoints);
        }
        let res = "";
        let i = 0;
        while (i < len) {
          res += String.fromCharCode.apply(
            String,
            codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
          );
        }
        return res;
      }
      function asciiSlice(buf, start, end) {
        let ret = "";
        end = Math.min(buf.length, end);
        for (let i = start; i < end; ++i) {
          ret += String.fromCharCode(buf[i] & 127);
        }
        return ret;
      }
      function latin1Slice(buf, start, end) {
        let ret = "";
        end = Math.min(buf.length, end);
        for (let i = start; i < end; ++i) {
          ret += String.fromCharCode(buf[i]);
        }
        return ret;
      }
      function hexSlice(buf, start, end) {
        const len = buf.length;
        if (!start || start < 0) start = 0;
        if (!end || end < 0 || end > len) end = len;
        let out = "";
        for (let i = start; i < end; ++i) {
          out += hexSliceLookupTable[buf[i]];
        }
        return out;
      }
      function utf16leSlice(buf, start, end) {
        const bytes = buf.slice(start, end);
        let res = "";
        for (let i = 0; i < bytes.length - 1; i += 2) {
          res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
        }
        return res;
      }
      Buffer2.prototype.slice = function slice(start, end) {
        const len = this.length;
        start = ~~start;
        end = end === void 0 ? len : ~~end;
        if (start < 0) {
          start += len;
          if (start < 0) start = 0;
        } else if (start > len) {
          start = len;
        }
        if (end < 0) {
          end += len;
          if (end < 0) end = 0;
        } else if (end > len) {
          end = len;
        }
        if (end < start) end = start;
        const newBuf = this.subarray(start, end);
        Object.setPrototypeOf(newBuf, Buffer2.prototype);
        return newBuf;
      };
      function checkOffset(offset, ext, length) {
        if (offset % 1 !== 0 || offset < 0) throw new RangeError("offset is not uint");
        if (offset + ext > length) throw new RangeError("Trying to access beyond buffer length");
      }
      Buffer2.prototype.readUintLE = Buffer2.prototype.readUIntLE = function readUIntLE(offset, byteLength2, noAssert) {
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) checkOffset(offset, byteLength2, this.length);
        let val = this[offset];
        let mul = 1;
        let i = 0;
        while (++i < byteLength2 && (mul *= 256)) {
          val += this[offset + i] * mul;
        }
        return val;
      };
      Buffer2.prototype.readUintBE = Buffer2.prototype.readUIntBE = function readUIntBE(offset, byteLength2, noAssert) {
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) {
          checkOffset(offset, byteLength2, this.length);
        }
        let val = this[offset + --byteLength2];
        let mul = 1;
        while (byteLength2 > 0 && (mul *= 256)) {
          val += this[offset + --byteLength2] * mul;
        }
        return val;
      };
      Buffer2.prototype.readUint8 = Buffer2.prototype.readUInt8 = function readUInt8(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 1, this.length);
        return this[offset];
      };
      Buffer2.prototype.readUint16LE = Buffer2.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 2, this.length);
        return this[offset] | this[offset + 1] << 8;
      };
      Buffer2.prototype.readUint16BE = Buffer2.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 2, this.length);
        return this[offset] << 8 | this[offset + 1];
      };
      Buffer2.prototype.readUint32LE = Buffer2.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return (this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16) + this[offset + 3] * 16777216;
      };
      Buffer2.prototype.readUint32BE = Buffer2.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return this[offset] * 16777216 + (this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3]);
      };
      Buffer2.prototype.readBigUInt64LE = defineBigIntMethod(function readBigUInt64LE(offset) {
        offset = offset >>> 0;
        validateNumber(offset, "offset");
        const first = this[offset];
        const last = this[offset + 7];
        if (first === void 0 || last === void 0) {
          boundsError(offset, this.length - 8);
        }
        const lo = first + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 24;
        const hi = this[++offset] + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + last * 2 ** 24;
        return BigInt(lo) + (BigInt(hi) << BigInt(32));
      });
      Buffer2.prototype.readBigUInt64BE = defineBigIntMethod(function readBigUInt64BE(offset) {
        offset = offset >>> 0;
        validateNumber(offset, "offset");
        const first = this[offset];
        const last = this[offset + 7];
        if (first === void 0 || last === void 0) {
          boundsError(offset, this.length - 8);
        }
        const hi = first * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + this[++offset];
        const lo = this[++offset] * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + last;
        return (BigInt(hi) << BigInt(32)) + BigInt(lo);
      });
      Buffer2.prototype.readIntLE = function readIntLE(offset, byteLength2, noAssert) {
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) checkOffset(offset, byteLength2, this.length);
        let val = this[offset];
        let mul = 1;
        let i = 0;
        while (++i < byteLength2 && (mul *= 256)) {
          val += this[offset + i] * mul;
        }
        mul *= 128;
        if (val >= mul) val -= Math.pow(2, 8 * byteLength2);
        return val;
      };
      Buffer2.prototype.readIntBE = function readIntBE(offset, byteLength2, noAssert) {
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) checkOffset(offset, byteLength2, this.length);
        let i = byteLength2;
        let mul = 1;
        let val = this[offset + --i];
        while (i > 0 && (mul *= 256)) {
          val += this[offset + --i] * mul;
        }
        mul *= 128;
        if (val >= mul) val -= Math.pow(2, 8 * byteLength2);
        return val;
      };
      Buffer2.prototype.readInt8 = function readInt8(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 1, this.length);
        if (!(this[offset] & 128)) return this[offset];
        return (255 - this[offset] + 1) * -1;
      };
      Buffer2.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 2, this.length);
        const val = this[offset] | this[offset + 1] << 8;
        return val & 32768 ? val | 4294901760 : val;
      };
      Buffer2.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 2, this.length);
        const val = this[offset + 1] | this[offset] << 8;
        return val & 32768 ? val | 4294901760 : val;
      };
      Buffer2.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16 | this[offset + 3] << 24;
      };
      Buffer2.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return this[offset] << 24 | this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3];
      };
      Buffer2.prototype.readBigInt64LE = defineBigIntMethod(function readBigInt64LE(offset) {
        offset = offset >>> 0;
        validateNumber(offset, "offset");
        const first = this[offset];
        const last = this[offset + 7];
        if (first === void 0 || last === void 0) {
          boundsError(offset, this.length - 8);
        }
        const val = this[offset + 4] + this[offset + 5] * 2 ** 8 + this[offset + 6] * 2 ** 16 + (last << 24);
        return (BigInt(val) << BigInt(32)) + BigInt(first + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 24);
      });
      Buffer2.prototype.readBigInt64BE = defineBigIntMethod(function readBigInt64BE(offset) {
        offset = offset >>> 0;
        validateNumber(offset, "offset");
        const first = this[offset];
        const last = this[offset + 7];
        if (first === void 0 || last === void 0) {
          boundsError(offset, this.length - 8);
        }
        const val = (first << 24) + // Overflow
        this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + this[++offset];
        return (BigInt(val) << BigInt(32)) + BigInt(this[++offset] * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + last);
      });
      Buffer2.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return ieee754.read(this, offset, true, 23, 4);
      };
      Buffer2.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 4, this.length);
        return ieee754.read(this, offset, false, 23, 4);
      };
      Buffer2.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 8, this.length);
        return ieee754.read(this, offset, true, 52, 8);
      };
      Buffer2.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
        offset = offset >>> 0;
        if (!noAssert) checkOffset(offset, 8, this.length);
        return ieee754.read(this, offset, false, 52, 8);
      };
      function checkInt(buf, value, offset, ext, max, min) {
        if (!Buffer2.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance');
        if (value > max || value < min) throw new RangeError('"value" argument is out of bounds');
        if (offset + ext > buf.length) throw new RangeError("Index out of range");
      }
      Buffer2.prototype.writeUintLE = Buffer2.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength2, noAssert) {
        value = +value;
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) {
          const maxBytes = Math.pow(2, 8 * byteLength2) - 1;
          checkInt(this, value, offset, byteLength2, maxBytes, 0);
        }
        let mul = 1;
        let i = 0;
        this[offset] = value & 255;
        while (++i < byteLength2 && (mul *= 256)) {
          this[offset + i] = value / mul & 255;
        }
        return offset + byteLength2;
      };
      Buffer2.prototype.writeUintBE = Buffer2.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength2, noAssert) {
        value = +value;
        offset = offset >>> 0;
        byteLength2 = byteLength2 >>> 0;
        if (!noAssert) {
          const maxBytes = Math.pow(2, 8 * byteLength2) - 1;
          checkInt(this, value, offset, byteLength2, maxBytes, 0);
        }
        let i = byteLength2 - 1;
        let mul = 1;
        this[offset + i] = value & 255;
        while (--i >= 0 && (mul *= 256)) {
          this[offset + i] = value / mul & 255;
        }
        return offset + byteLength2;
      };
      Buffer2.prototype.writeUint8 = Buffer2.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 1, 255, 0);
        this[offset] = value & 255;
        return offset + 1;
      };
      Buffer2.prototype.writeUint16LE = Buffer2.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
        this[offset] = value & 255;
        this[offset + 1] = value >>> 8;
        return offset + 2;
      };
      Buffer2.prototype.writeUint16BE = Buffer2.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
        this[offset] = value >>> 8;
        this[offset + 1] = value & 255;
        return offset + 2;
      };
      Buffer2.prototype.writeUint32LE = Buffer2.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
        this[offset + 3] = value >>> 24;
        this[offset + 2] = value >>> 16;
        this[offset + 1] = value >>> 8;
        this[offset] = value & 255;
        return offset + 4;
      };
      Buffer2.prototype.writeUint32BE = Buffer2.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
        this[offset] = value >>> 24;
        this[offset + 1] = value >>> 16;
        this[offset + 2] = value >>> 8;
        this[offset + 3] = value & 255;
        return offset + 4;
      };
      function wrtBigUInt64LE(buf, value, offset, min, max) {
        checkIntBI(value, min, max, buf, offset, 7);
        let lo = Number(value & BigInt(4294967295));
        buf[offset++] = lo;
        lo = lo >> 8;
        buf[offset++] = lo;
        lo = lo >> 8;
        buf[offset++] = lo;
        lo = lo >> 8;
        buf[offset++] = lo;
        let hi = Number(value >> BigInt(32) & BigInt(4294967295));
        buf[offset++] = hi;
        hi = hi >> 8;
        buf[offset++] = hi;
        hi = hi >> 8;
        buf[offset++] = hi;
        hi = hi >> 8;
        buf[offset++] = hi;
        return offset;
      }
      function wrtBigUInt64BE(buf, value, offset, min, max) {
        checkIntBI(value, min, max, buf, offset, 7);
        let lo = Number(value & BigInt(4294967295));
        buf[offset + 7] = lo;
        lo = lo >> 8;
        buf[offset + 6] = lo;
        lo = lo >> 8;
        buf[offset + 5] = lo;
        lo = lo >> 8;
        buf[offset + 4] = lo;
        let hi = Number(value >> BigInt(32) & BigInt(4294967295));
        buf[offset + 3] = hi;
        hi = hi >> 8;
        buf[offset + 2] = hi;
        hi = hi >> 8;
        buf[offset + 1] = hi;
        hi = hi >> 8;
        buf[offset] = hi;
        return offset + 8;
      }
      Buffer2.prototype.writeBigUInt64LE = defineBigIntMethod(function writeBigUInt64LE(value, offset = 0) {
        return wrtBigUInt64LE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
      });
      Buffer2.prototype.writeBigUInt64BE = defineBigIntMethod(function writeBigUInt64BE(value, offset = 0) {
        return wrtBigUInt64BE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
      });
      Buffer2.prototype.writeIntLE = function writeIntLE(value, offset, byteLength2, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) {
          const limit = Math.pow(2, 8 * byteLength2 - 1);
          checkInt(this, value, offset, byteLength2, limit - 1, -limit);
        }
        let i = 0;
        let mul = 1;
        let sub = 0;
        this[offset] = value & 255;
        while (++i < byteLength2 && (mul *= 256)) {
          if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
            sub = 1;
          }
          this[offset + i] = (value / mul >> 0) - sub & 255;
        }
        return offset + byteLength2;
      };
      Buffer2.prototype.writeIntBE = function writeIntBE(value, offset, byteLength2, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) {
          const limit = Math.pow(2, 8 * byteLength2 - 1);
          checkInt(this, value, offset, byteLength2, limit - 1, -limit);
        }
        let i = byteLength2 - 1;
        let mul = 1;
        let sub = 0;
        this[offset + i] = value & 255;
        while (--i >= 0 && (mul *= 256)) {
          if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
            sub = 1;
          }
          this[offset + i] = (value / mul >> 0) - sub & 255;
        }
        return offset + byteLength2;
      };
      Buffer2.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 1, 127, -128);
        if (value < 0) value = 255 + value + 1;
        this[offset] = value & 255;
        return offset + 1;
      };
      Buffer2.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
        this[offset] = value & 255;
        this[offset + 1] = value >>> 8;
        return offset + 2;
      };
      Buffer2.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
        this[offset] = value >>> 8;
        this[offset + 1] = value & 255;
        return offset + 2;
      };
      Buffer2.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
        this[offset] = value & 255;
        this[offset + 1] = value >>> 8;
        this[offset + 2] = value >>> 16;
        this[offset + 3] = value >>> 24;
        return offset + 4;
      };
      Buffer2.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
        if (value < 0) value = 4294967295 + value + 1;
        this[offset] = value >>> 24;
        this[offset + 1] = value >>> 16;
        this[offset + 2] = value >>> 8;
        this[offset + 3] = value & 255;
        return offset + 4;
      };
      Buffer2.prototype.writeBigInt64LE = defineBigIntMethod(function writeBigInt64LE(value, offset = 0) {
        return wrtBigUInt64LE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
      });
      Buffer2.prototype.writeBigInt64BE = defineBigIntMethod(function writeBigInt64BE(value, offset = 0) {
        return wrtBigUInt64BE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
      });
      function checkIEEE754(buf, value, offset, ext, max, min) {
        if (offset + ext > buf.length) throw new RangeError("Index out of range");
        if (offset < 0) throw new RangeError("Index out of range");
      }
      function writeFloat(buf, value, offset, littleEndian, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) {
          checkIEEE754(buf, value, offset, 4, 34028234663852886e22, -34028234663852886e22);
        }
        ieee754.write(buf, value, offset, littleEndian, 23, 4);
        return offset + 4;
      }
      Buffer2.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
        return writeFloat(this, value, offset, true, noAssert);
      };
      Buffer2.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
        return writeFloat(this, value, offset, false, noAssert);
      };
      function writeDouble(buf, value, offset, littleEndian, noAssert) {
        value = +value;
        offset = offset >>> 0;
        if (!noAssert) {
          checkIEEE754(buf, value, offset, 8, 17976931348623157e292, -17976931348623157e292);
        }
        ieee754.write(buf, value, offset, littleEndian, 52, 8);
        return offset + 8;
      }
      Buffer2.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
        return writeDouble(this, value, offset, true, noAssert);
      };
      Buffer2.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
        return writeDouble(this, value, offset, false, noAssert);
      };
      Buffer2.prototype.copy = function copy(target, targetStart, start, end) {
        if (!Buffer2.isBuffer(target)) throw new TypeError("argument should be a Buffer");
        if (!start) start = 0;
        if (!end && end !== 0) end = this.length;
        if (targetStart >= target.length) targetStart = target.length;
        if (!targetStart) targetStart = 0;
        if (end > 0 && end < start) end = start;
        if (end === start) return 0;
        if (target.length === 0 || this.length === 0) return 0;
        if (targetStart < 0) {
          throw new RangeError("targetStart out of bounds");
        }
        if (start < 0 || start >= this.length) throw new RangeError("Index out of range");
        if (end < 0) throw new RangeError("sourceEnd out of bounds");
        if (end > this.length) end = this.length;
        if (target.length - targetStart < end - start) {
          end = target.length - targetStart + start;
        }
        const len = end - start;
        if (this === target && typeof Uint8Array.prototype.copyWithin === "function") {
          this.copyWithin(targetStart, start, end);
        } else {
          Uint8Array.prototype.set.call(
            target,
            this.subarray(start, end),
            targetStart
          );
        }
        return len;
      };
      Buffer2.prototype.fill = function fill(val, start, end, encoding) {
        if (typeof val === "string") {
          if (typeof start === "string") {
            encoding = start;
            start = 0;
            end = this.length;
          } else if (typeof end === "string") {
            encoding = end;
            end = this.length;
          }
          if (encoding !== void 0 && typeof encoding !== "string") {
            throw new TypeError("encoding must be a string");
          }
          if (typeof encoding === "string" && !Buffer2.isEncoding(encoding)) {
            throw new TypeError("Unknown encoding: " + encoding);
          }
          if (val.length === 1) {
            const code = val.charCodeAt(0);
            if (encoding === "utf8" && code < 128 || encoding === "latin1") {
              val = code;
            }
          }
        } else if (typeof val === "number") {
          val = val & 255;
        } else if (typeof val === "boolean") {
          val = Number(val);
        }
        if (start < 0 || this.length < start || this.length < end) {
          throw new RangeError("Out of range index");
        }
        if (end <= start) {
          return this;
        }
        start = start >>> 0;
        end = end === void 0 ? this.length : end >>> 0;
        if (!val) val = 0;
        let i;
        if (typeof val === "number") {
          for (i = start; i < end; ++i) {
            this[i] = val;
          }
        } else {
          const bytes = Buffer2.isBuffer(val) ? val : Buffer2.from(val, encoding);
          const len = bytes.length;
          if (len === 0) {
            throw new TypeError('The value "' + val + '" is invalid for argument "value"');
          }
          for (i = 0; i < end - start; ++i) {
            this[i + start] = bytes[i % len];
          }
        }
        return this;
      };
      var errors = {};
      function E(sym, getMessage, Base) {
        errors[sym] = class NodeError extends Base {
          constructor() {
            super();
            Object.defineProperty(this, "message", {
              value: getMessage.apply(this, arguments),
              writable: true,
              configurable: true
            });
            this.name = `${this.name} [${sym}]`;
            this.stack;
            delete this.name;
          }
          get code() {
            return sym;
          }
          set code(value) {
            Object.defineProperty(this, "code", {
              configurable: true,
              enumerable: true,
              value,
              writable: true
            });
          }
          toString() {
            return `${this.name} [${sym}]: ${this.message}`;
          }
        };
      }
      E(
        "ERR_BUFFER_OUT_OF_BOUNDS",
        function(name) {
          if (name) {
            return `${name} is outside of buffer bounds`;
          }
          return "Attempt to access memory outside buffer bounds";
        },
        RangeError
      );
      E(
        "ERR_INVALID_ARG_TYPE",
        function(name, actual) {
          return `The "${name}" argument must be of type number. Received type ${typeof actual}`;
        },
        TypeError
      );
      E(
        "ERR_OUT_OF_RANGE",
        function(str, range, input) {
          let msg = `The value of "${str}" is out of range.`;
          let received = input;
          if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
            received = addNumericalSeparator(String(input));
          } else if (typeof input === "bigint") {
            received = String(input);
            if (input > BigInt(2) ** BigInt(32) || input < -(BigInt(2) ** BigInt(32))) {
              received = addNumericalSeparator(received);
            }
            received += "n";
          }
          msg += ` It must be ${range}. Received ${received}`;
          return msg;
        },
        RangeError
      );
      function addNumericalSeparator(val) {
        let res = "";
        let i = val.length;
        const start = val[0] === "-" ? 1 : 0;
        for (; i >= start + 4; i -= 3) {
          res = `_${val.slice(i - 3, i)}${res}`;
        }
        return `${val.slice(0, i)}${res}`;
      }
      function checkBounds(buf, offset, byteLength2) {
        validateNumber(offset, "offset");
        if (buf[offset] === void 0 || buf[offset + byteLength2] === void 0) {
          boundsError(offset, buf.length - (byteLength2 + 1));
        }
      }
      function checkIntBI(value, min, max, buf, offset, byteLength2) {
        if (value > max || value < min) {
          const n = typeof min === "bigint" ? "n" : "";
          let range;
          if (byteLength2 > 3) {
            if (min === 0 || min === BigInt(0)) {
              range = `>= 0${n} and < 2${n} ** ${(byteLength2 + 1) * 8}${n}`;
            } else {
              range = `>= -(2${n} ** ${(byteLength2 + 1) * 8 - 1}${n}) and < 2 ** ${(byteLength2 + 1) * 8 - 1}${n}`;
            }
          } else {
            range = `>= ${min}${n} and <= ${max}${n}`;
          }
          throw new errors.ERR_OUT_OF_RANGE("value", range, value);
        }
        checkBounds(buf, offset, byteLength2);
      }
      function validateNumber(value, name) {
        if (typeof value !== "number") {
          throw new errors.ERR_INVALID_ARG_TYPE(name, "number", value);
        }
      }
      function boundsError(value, length, type) {
        if (Math.floor(value) !== value) {
          validateNumber(value, type);
          throw new errors.ERR_OUT_OF_RANGE(type || "offset", "an integer", value);
        }
        if (length < 0) {
          throw new errors.ERR_BUFFER_OUT_OF_BOUNDS();
        }
        throw new errors.ERR_OUT_OF_RANGE(
          type || "offset",
          `>= ${type ? 1 : 0} and <= ${length}`,
          value
        );
      }
      var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;
      function base64clean(str) {
        str = str.split("=")[0];
        str = str.trim().replace(INVALID_BASE64_RE, "");
        if (str.length < 2) return "";
        while (str.length % 4 !== 0) {
          str = str + "=";
        }
        return str;
      }
      function utf8ToBytes(string, units) {
        units = units || Infinity;
        let codePoint;
        const length = string.length;
        let leadSurrogate = null;
        const bytes = [];
        for (let i = 0; i < length; ++i) {
          codePoint = string.charCodeAt(i);
          if (codePoint > 55295 && codePoint < 57344) {
            if (!leadSurrogate) {
              if (codePoint > 56319) {
                if ((units -= 3) > -1) bytes.push(239, 191, 189);
                continue;
              } else if (i + 1 === length) {
                if ((units -= 3) > -1) bytes.push(239, 191, 189);
                continue;
              }
              leadSurrogate = codePoint;
              continue;
            }
            if (codePoint < 56320) {
              if ((units -= 3) > -1) bytes.push(239, 191, 189);
              leadSurrogate = codePoint;
              continue;
            }
            codePoint = (leadSurrogate - 55296 << 10 | codePoint - 56320) + 65536;
          } else if (leadSurrogate) {
            if ((units -= 3) > -1) bytes.push(239, 191, 189);
          }
          leadSurrogate = null;
          if (codePoint < 128) {
            if ((units -= 1) < 0) break;
            bytes.push(codePoint);
          } else if (codePoint < 2048) {
            if ((units -= 2) < 0) break;
            bytes.push(
              codePoint >> 6 | 192,
              codePoint & 63 | 128
            );
          } else if (codePoint < 65536) {
            if ((units -= 3) < 0) break;
            bytes.push(
              codePoint >> 12 | 224,
              codePoint >> 6 & 63 | 128,
              codePoint & 63 | 128
            );
          } else if (codePoint < 1114112) {
            if ((units -= 4) < 0) break;
            bytes.push(
              codePoint >> 18 | 240,
              codePoint >> 12 & 63 | 128,
              codePoint >> 6 & 63 | 128,
              codePoint & 63 | 128
            );
          } else {
            throw new Error("Invalid code point");
          }
        }
        return bytes;
      }
      function asciiToBytes(str) {
        const byteArray = [];
        for (let i = 0; i < str.length; ++i) {
          byteArray.push(str.charCodeAt(i) & 255);
        }
        return byteArray;
      }
      function utf16leToBytes(str, units) {
        let c, hi, lo;
        const byteArray = [];
        for (let i = 0; i < str.length; ++i) {
          if ((units -= 2) < 0) break;
          c = str.charCodeAt(i);
          hi = c >> 8;
          lo = c % 256;
          byteArray.push(lo);
          byteArray.push(hi);
        }
        return byteArray;
      }
      function base64ToBytes(str) {
        return base64.toByteArray(base64clean(str));
      }
      function blitBuffer(src, dst, offset, length) {
        let i;
        for (i = 0; i < length; ++i) {
          if (i + offset >= dst.length || i >= src.length) break;
          dst[i + offset] = src[i];
        }
        return i;
      }
      function isInstance(obj, type) {
        return obj instanceof type || obj != null && obj.constructor != null && obj.constructor.name != null && obj.constructor.name === type.name;
      }
      function numberIsNaN(obj) {
        return obj !== obj;
      }
      var hexSliceLookupTable = function() {
        const alphabet = "0123456789abcdef";
        const table = new Array(256);
        for (let i = 0; i < 16; ++i) {
          const i16 = i * 16;
          for (let j = 0; j < 16; ++j) {
            table[i16 + j] = alphabet[i] + alphabet[j];
          }
        }
        return table;
      }();
      function defineBigIntMethod(fn) {
        return typeof BigInt === "undefined" ? BufferBigIntNotDefined : fn;
      }
      function BufferBigIntNotDefined() {
        throw new Error("BigInt not supported");
      }
    }
  });

  // vendor/config.js
  var require_config = __commonJS({
    "vendor/config.js"(exports, module) {
      "use strict";
      var HOST = "0.0.0.0";
      var PUBLIC_HOST = "";
      var SIP_PORT = 5060;
      var BACKEND = "auto";
      var ROLE = "answer";
      var QEMU_PATH = ".\\win\\qemu\\qemu-system-i386.exe";
      var VM_ACCEL = null;
      var AT_INIT = ["AT&E0"];
      var AUDIO_PORT = 25800;
      var CONTROL_PORT = 25801;
      var LOG_LEVEL = "info";
      var GUEST_LOG_LEVEL = "debug";
      var CAPTURE_AUDIO = false;
      var BOOT_LOG_PATH = "";
      module.exports = {
        // ─────────────────────────────────────────────────────────────────────────────
        // SIP SERVER
        // ─────────────────────────────────────────────────────────────────────────────
        sip: {
          // Interface to bind. '0.0.0.0' listens on all interfaces.
          host: HOST,
          // UDP and TCP SIP port (standard is 5060)
          port: SIP_PORT,
          // IP advertised in SIP Via/Contact and SDP `c=` lines. The caller
          // sends RTP to whatever IP appears in our SDP, so this must be
          // reachable FROM THE CALLER (not just locally bound).
          //
          // Default: empty string ('') — auto-resolved per call:
          //   1. Per-call subnet match: pick the local interface whose IPv4
          //      subnet contains the caller's source IP. Correct in nearly
          //      every multi-NIC LAN deployment.
          //   2. First non-loopback IPv4: when no interface matches, use
          //      the first non-internal IPv4 (sorted by interface name for
          //      determinism). Logged at WARN per call so the operator
          //      knows the heuristic kicked in.
          //   3. 127.0.0.1: only when no non-loopback IPv4 exists at all.
          //      Logged at WARN; works for loopback testing only.
          //
          // Set this to a specific IP string to bypass auto-resolution —
          // useful behind NAT or an SBC where the externally-visible IP
          // doesn't match any local interface. See PublicHostResolver for
          // implementation details.
          publicHost: PUBLIC_HOST,
          // Domain used in From/To headers for generated responses
          domain: "synthmodem.local",
          // SIP User-Agent string sent in responses
          userAgent: "SynthModem/1.0",
          // How long (ms) to wait for ACK after sending 200 OK before giving up
          ackTimeoutMs: 5e3,
          // How long (ms) of silence on RTP before considering the call dead
          rtpTimeoutMs: 3e4,
          // Re-INVITE / re-negotiation: accept or reject
          acceptReInvite: true,
          // SIP OPTIONS keepalive: respond to OPTIONS pings
          respondToOptions: true,
          // Maximum simultaneous SIP dialogs tracked (even if only one is active)
          maxDialogs: 8
        },
        // ─────────────────────────────────────────────────────────────────────────────
        // RTP
        // ─────────────────────────────────────────────────────────────────────────────
        rtp: {
          // UDP port range for RTP sessions (even ports used, RTCP on port+1)
          portMin: 1e4,
          portMax: 10100,
          // Audio sample rate. G.711 is always 8000 Hz.
          sampleRate: 8e3,
          // RTP packetisation interval in milliseconds (20ms = 160 samples at 8kHz)
          packetIntervalMs: 20,
          // Jitter buffer size in packets (each packet = packetIntervalMs)
          // Applies only to the legacy adaptive 'buffered' mode.
          jitterBufferPackets: 4,
          // Jitter buffer max size before packets are dropped (legacy 'buffered' mode)
          jitterBufferMaxPackets: 16,
          // ── Fixed-buffered mode parameters (mode === 'fixed-buffered') ──
          //
          // These control the D-Modem-style fixed-depth jitter buffer. The
          // goal is to absorb network jitter with a deep queue rather than
          // adapt the buffer's size dynamically (which would inject or drop
          // samples — fatal for modems).
          // Number of packets to buffer before starting playout. D-Modem
          // uses 40 (800ms at 20ms pkt-time). Higher = more tolerance for
          // burst loss and bad jitter, but more added latency. Modems don't
          // care about latency, so erring high is safe.
          jitterBufferInitDepth: 40,
          // Hard cap on buffer depth. If packets arrive faster than we drain,
          // we drop the oldest beyond this. D-Modem uses 500 (10s). We also
          // default to 500; well above anything a sane network should produce.
          jitterBufferMaxDepth: 500,
          // How many consecutive missed ticks before we give up on the
          // current expected seq and jump to the nearest future seq held in
          // the buffer. Without this the buffer could stall forever if a
          // packet was truly lost in transit. 50 ticks = 1 second at 20ms.
          jitterBufferMissSkipTicks: 50,
          // Payload types to offer in SDP (96+ are dynamic; 0=PCMU, 8=PCMA)
          // Listed in preference order
          preferredCodecs: [
            { name: "PCMU", payloadType: 0, clockRate: 8e3 },
            // G.711 µ-law
            { name: "PCMA", payloadType: 8, clockRate: 8e3 },
            // G.711 a-law
            { name: "L16", payloadType: 11, clockRate: 8e3 }
            // Linear 16-bit (testing)
          ],
          // Drop RTP packets with sequence number gap larger than this
          maxSeqGap: 64,
          // SSRC for outgoing RTP stream (0 = random)
          outboundSsrc: 0,
          // Playout mode — controls how incoming RTP packets reach the DSP.
          //
          //   'buffered'  — adaptive jitter buffer (legacy). Packets go into
          //                 a jitter buffer and are released at
          //                 packetIntervalMs intervals. If a packet is missing
          //                 at tick time, a zero-filled concealment frame is
          //                 emitted to keep a steady cadence. Good for voice;
          //                 the 40-80ms added latency is imperceptible and
          //                 the concealment masks brief network jitter. BAD
          //                 for modems: silence frames break the DSP PLL lock
          //                 and cause NO CARRIER.
          //
          //   'immediate' — skip the jitter buffer and concealment. Emit
          //                 'audio' synchronously the moment a packet is
          //                 decoded. No concealment ever. Originally used
          //                 as a modem workaround. Trade-off: no reorder
          //                 tolerance and duplicate packets slip through.
          //                 On Windows, setInterval(20) drifts enough that
          //                 buffered mode can consume faster than packets
          //                 arrive — which immediate mode side-steps entirely.
          //
          //   'fixed-buffered' — D-Modem-style fixed-depth queue. Packets
          //                 accumulate until jitterBufferInitDepth are held;
          //                 then playback starts at 20ms cadence. On miss,
          //                 we SKIP THE TICK instead of emitting silence
          //                 (so the modem DSP never sees fake samples). On
          //                 severe underrun we re-sync to the next available
          //                 seq. On overflow we drop oldest. This is the
          //                 approach that makes D-Modem connections last
          //                 days instead of minutes. Recommended for modem
          //                 use; cost is a fixed ~800ms of added latency.
          //
          // The slmodemd backend forces 'fixed-buffered' by default (see
          // CallSession), overriding this setting. Native-DSP mode respects
          // this config.
          playoutMode: "fixed-buffered"
        },
        // ─────────────────────────────────────────────────────────────────────────────
        // MODEM DSP ENGINE
        // ─────────────────────────────────────────────────────────────────────────────
        modem: {
          // ─────────────────────────────────────────────────────────────────
          // Backend selection (and shared options that apply to both backends)
          // ─────────────────────────────────────────────────────────────────
          // Which modem engine to use. EXPLICIT — no auto-detection.
          //
          //   'native'          built-in pure-JS modem backend, in-process.
          //                     Active protocols: V.21 / V.22 / Bell 103.
          //                     V.22bis and V.23 also live in the registry as
          //                     TESTING (operators must opt them in via
          //                     `protocolPreference` / `v8ModulationModes` —
          //                     they are not currently known to train against
          //                     real hardware modems and are kept as the basis
          //                     for future fix work). Native answer-side V.8
          //                     and answer-tone signaling come from this
          //                     config section's `native:` subtree below.
          //                     Works on Linux, macOS, and Windows; no native
          //                     addon, no toolchain prerequisite as of
          //                     cleanup-phase-2.
          //
          //   'slmodemd-pjsip'  slmodemd DSP under QEMU, with PJSIP handling
          //                     SIP and RTP inside the VM (via vendored
          //                     d-modem.c). SynthModem acts as a SIP B2BUA
          //                     bridging the external caller's SIP/RTP leg
          //                     to an internal SIP leg terminated by PJSIP +
          //                     d-modem inside the guest. All of D-Modem's
          //                     media optimizations apply — software clock,
          //                     fixed jitter buffer, PLC/VAD/EC off, PCMU
          //                     priority, direct socketpair coupling — giving
          //                     robust handshake reliability for V.32bis
          //                     through V.34/V.90. slmodemd's own
          //                     internal V.8 stack handles negotiation; the
          //                     `native:` keys below have no effect for this
          //                     backend. Requires the bundled QEMU + VM image
          //                     (`make -C vm`).
          //
          //   'auto'            Combines both. Calls start in slmodemd-pjsip
          //                     b2bua mode so V.8-capable callers reach the
          //                     full V.34/V.32bis range. If slmodemd's V.8
          //                     negotiation times out without seeing CM (the
          //                     deterministic ~12-second NO CARRIER pattern
          //                     that vintage non-V.8 callers produce — see
          //                     boot logs captured 2026-04-30 19:44-19:46),
          //                     the VM is recycled, the local RTP socket is
          //                     adopted by an in-process RtpSession, and the
          //                     native backend takes over with V.8 and ANSam
          //                     skipped (the caller has already heard ANSam
          //                     from PJSIP and is sitting in V.25 "answer-
          //                     tone-heard, awaiting training" state). The
          //                     native legacy automode probe chain
          //                     (V.22bis → V.21 → Bell103) handles the rest.
          //                     Capture in this mode covers only the post-
          //                     swap (native) portion — the b2bua portion
          //                     before the swap is currently not captured.
          //
          // If 'slmodemd-pjsip' is selected but the VM image or QEMU is
          // missing, synthmodem will fail at start with a clear message.
          backend: BACKEND,
          // Role: 'answer'    — SynthModem is the answering modem (server use).
          //       'originate' — SynthModem dials out (test client use).
          role: ROLE,
          // Per-call WAV capture for offline analysis.
          //
          // Today this works ONLY for backend === 'native' (where Node owns
          // the decoded PCM stream end-to-end). For 'slmodemd-pjsip' the
          // option is a no-op at runtime: Node only sees raw PCMU bytes
          // moving through RtpBridge, never the decoded audio, so there's
          // no PCM stream to write to a WAV.
          //
          // Future work (Phase 4-5): implement direction-tagged capture for
          // 'slmodemd-pjsip' by snooping RtpBridge._forward, which is the
          // single chokepoint where every RTP packet (both directions)
          // passes through Node. Outputs would be a per-direction WAV with
          // PCMU codec (RFC 7656; WAV mu-law format code 7) and/or a .pcap
          // of the RTP datagrams for replay through the actual stack. The
          // hook is small (~10 lines) but the format and on-disk layout
          // need design — deferred until then.
          //
          // For now, leave true and rely on it for native-backend debugging;
          // the runtime logs "captureAudio requested but ignored in b2bua
          // mode" once per call when slmodemd-pjsip is selected, so it's
          // benign.
          captureAudio: CAPTURE_AUDIO,
          captureDir: "./captures",
          // TX-timing diagnostic trace. When true and captureAudio is also
          // true, the per-call capture will include a `<base>_tx_timing.txt`
          // file containing a high-resolution timestamp + RTP sequence number
          // for every outbound RTP packet. Use tools/analyze-tx-timing.js
          // to read the trace and characterize inter-packet jitter relative
          // to the ideal 20 ms cadence.
          //
          // Off by default — minimal but nonzero overhead per send (one
          // hrtime call + one typed-array store), which is fine for
          // diagnostic runs but unnecessary in production.
          traceTxTiming: false,
          // ─────────────────────────────────────────────────────────────────
          // native — options for backend === 'native'
          // ─────────────────────────────────────────────────────────────────
          //
          // These keys are silently ignored when backend === 'slmodemd-pjsip'
          // (slmodemd's own DSP handles signaling and protocol selection
          // internally over its AT command set; see the `slmodemd-pjsip:`
          // section below for that path's atInit hook).
          native: {
            // ── Protocol selection ────────────────────────────────────────
            // Protocol negotiation order, highest preference first. SynthModem
            // tries these during V.8 handshake when neither `forceProtocol`
            // nor `advertiseProtocol` overrides selection.
            //
            // Active native protocols (validated end-to-end against real
            // hardware modems over SIP/RTP, April 2026):
            //   'V22bis'   — 2400 bps 16-QAM (V.22bis-spandsp port)
            //   'V22'      — 1200 bps DPSK
            //   'V23'      — 1200/75 bps split-speed FSK
            //   'V21'      — 300 bps FSK
            //   'Bell103'  — 300 bps FSK (US legacy)
            //
            // V.32bis and V.34 were removed in cleanup-phase-2 along with
            // the spandsp dependency. The slmodemd-pjsip backend covers
            // those high-speed paths via its proprietary DSP.
            protocolPreference: ["V22bis", "V22", "V23", "V21", "Bell103"],
            // V.8 menu — list of modulation modes to advertise in CM. Subset
            // of protocolPreference. Advertising a protocol here that we
            // can't actually train will cause the caller to attempt training
            // and fail; only advertise what we can complete.
            v8ModulationModes: ["V22bis", "V22", "V23", "V21", "Bell103"],
            // Force a specific protocol regardless of negotiation. null =
            // negotiate via V.8 / per protocolPreference. Bypasses V.8 entirely.
            // Example: 'V22'
            forceProtocol: null,
            // Originate-side: advertise only this protocol in our V.8 CM.
            // Useful from the test client to make the answering side select
            // a specific protocol via legitimate V.8 negotiation rather than
            // forceProtocol's bypass. null = advertise the full
            // protocolPreference.
            // Example: 'V22' — answer side will select V22 because we only
            // advertise V22.
            advertiseProtocol: null,
            // ── Answer tone (ITU-T V.25) ──────────────────────────────────
            // Delay between call connect and the start of ANS/ANSam tone, in ms.
            answerToneDelayMs: 1e3,
            // Duration of 2100 Hz ANS tone, in ms. ITU spec: 2.6–4 s,
            // 3.3 s typical.
            answerToneDurationMs: 3300,
            // ANSam (phase-reversal) tone instead of plain ANS:
            //   true  — V.8-capable signaling (modern caller modems expect this)
            //   false — legacy V.25 ANS only
            useANSam: true,
            // Phase reversal interval for ANSam, in ms. ITU spec: 450 ms.
            answerTonePhaseReversalMs: 450,
            // ── V.8 handshake ─────────────────────────────────────────────
            // Whether to use V.8 CM/JM call-menu exchange before training.
            // true  — emit V.8 (works with V.8-capable callers; legacy V.25
            //         callers will time out our CM wait and we fall through
            //         to direct training).
            // false — skip V.8 and go straight to the forced protocol's
            //         training sequence.
            enableV8: true,
            // ── Post-training idle hold ("V.42 Penalty Box") ──────────────
            //
            // After modem training completes, we must transmit continuous
            // mark-idle (scrambled binary 1s) for some seconds before sending
            // any real payload. This is NOT optional for modern modems. Two
            // reasons:
            //
            //   1. V.22/V.22bis spec-mandated idle: ITU-T V.22bis §6.3.1.2.2
            //      requires the answerer to transmit scrambled binary 1s for
            //      765 ms so the caller's descrambler can lock and the caller
            //      can assert its own Carrier Detect. spandsp's TIMED_S11
            //      stage handles this internally before firing
            //      TRAINING_SUCCEEDED, so by the time we see the 'connected'
            //      event this requirement is already met.
            //
            //   2. V.42 / LAPM detection window: modern modems default to
            //      V.42 error correction. After physical-layer training they
            //      spend up to 8-10 seconds transmitting V.42 ODP (Originator
            //      Detection Pattern) XID-like frames trying to initiate
            //      LAPM. synthmodem does not implement V.42; we cannot
            //      respond to ODP with an ADP or negotiate LAPM. So we must
            //      simply wait it out. The caller's V.42 state machine will
            //      eventually notice nothing is responding, drop into
            //      Normal/Direct mode, and finally assert DCD to its DTE.
            //
            // During the hold, TWO things must be true:
            //
            //   A. We must NOT transmit payload bytes. To the caller, any
            //      ASCII data arriving during V.42 ODP is line corruption,
            //      and strict modems will drop the call. Our binding's
            //      get_bit callback naturally outputs continuous mark-idle
            //      (all 1s, scrambled by spandsp) when the byte queue is
            //      empty — exactly what the caller needs. Implemented by
            //      deferring the TelnetProxy attach until after the hold.
            //
            //   B. We must DISCARD received bytes. During the hold the
            //      caller fires V.42 XID frames at us; they descramble to
            //      arbitrary bytes that must not reach the TelnetProxy (the
            //      menu would interpret them as user input and try to open
            //      TCP connections to garbage hostnames). Implemented by
            //      deferring the normal _dsp.on('data') → telnet.receive
            //      hookup until after the hold.
            //
            // HOLD STRATEGY — two-phase:
            //
            //   Phase 1 (MIN HOLD): unconditional `postTrainIdleMs` wait.
            //   Covers the V.22 §6.3.1.2.2 tail and the shortest V.42 timers.
            //
            //   Phase 2 (QUIESCENCE WAIT): after the min hold, keep attaching
            //   TelnetProxy deferred AS LONG AS the RX byte stream keeps
            //   flowing. The caller finishes V.42 and drops into mark idle,
            //   which our binding suppresses as 0xFF → no bytes emitted. So
            //   when the byte stream goes quiet for `postTrainQuiescenceMs`,
            //   we attach.
            //
            // This adapts automatically to different modems:
            //   - AT&Q0 (V.42 disabled): no bytes during hold, immediate
            //     attach after postTrainIdleMs elapses.
            //   - Modern modems with 2-3 s V.42 timers: bytes flow 2-3 s
            //     then stop; attach fires ~500 ms after that.
            //   - Pathological modems with 8-9 s V.42 timers: bytes flow
            //     for the full window; attach fires ~500 ms after they stop.
            //   - Something pathological that never stops:
            //     `postTrainAttachMaxMs` cap fires so we never wait forever.
            //
            // Default values are tuned against real modem observations:
            //
            //   - 6000 ms min hold: empirically confirmed sufficient to let
            //     a default-config consumer modem (V.42-enabled) complete
            //     its ODP detection and fall back to Normal/Direct mode.
            //     4000 ms was NOT sufficient on the same modem. 3000 ms
            //     fires the banner mid-V.42, which some modems tolerate and
            //     some don't.
            //
            //   - 500 ms quiescence: after V.42 finishes, the caller drops
            //     into scrambled mark idle (0xFF through our binding,
            //     suppressed), so the RX byte stream goes silent. 500 ms
            //     comfortably beats worst-case inter-frame gaps in active
            //     V.42 ODP transmission.
            //
            //   - 15000 ms hard cap: for pathological modems that never
            //     quiesce. We attach anyway after this; better to leak some
            //     bytes than hang indefinitely.
            postTrainIdleMs: 6e3,
            // Minimum hold duration (ms)
            postTrainQuiescenceMs: 500,
            // Time without RX bytes to declare V.42 done (ms)
            postTrainAttachMaxMs: 15e3,
            // Hard cap on total wait (ms)
            // ── Per-protocol training sequence duration (ms) ──────────────
            // These are MINIMUMS. Most actual training runs are longer.
            // V22bis and V23 entries are kept because their classes still
            // exist in the registry as TESTING — operators who opt them in
            // need a training duration. V.32bis and V.34 entries were dropped
            // when those protocols left in cleanup-phase-2.
            trainingDurationMs: {
              V21: 0,
              // FSK — no training needed
              Bell103: 0,
              // FSK — no training needed
              V22: 600,
              V22bis: 600,
              // TESTING
              V23: 0
              // TESTING
            },
            // ── DSP internals ─────────────────────────────────────────────
            // Internal processing block size in samples.
            blockSizeSamples: 160,
            // Tolerance (Hz) for slightly mis-tuned carriers.
            carrierToleranceHz: 10,
            // ── Phase-2 note on dropped DSP knobs ─────────────────────────
            //
            // The following keys were removed in cleanup-phase-2 along with
            // the QAM protocols that consumed them:
            //
            //   agcEnabled, agcTargetLevel, agcAttackAlpha, agcDecayAlpha
            //     — AGC class still lives in Primitives.js (retained for any
            //       future native-V.22bis fix work) but no active protocol
            //       uses it; ModemDSP no longer instantiates it.
            //
            //   equalizer.{taps, stepSize, pretrainSymbols}
            //     — LMSEqualizer class retained in Primitives.js for the
            //       same reason; not currently consumed anywhere.
            //
            //   timingRecovery.{loopGain, maxOffsetFraction}
            //     — GardnerTiming class retained in Primitives.js, same
            //       reason.
            //
            //   scramblerPolynomial
            //     — V.34 / V.32bis self-sync scrambler config; the V.22
            //       PUREJS implementation has its own internal V22Scrambler
            //       class so this top-level key was unused by any surviving
            //       protocol.
            //
            // If a future phase fixes V.22bis or revisits a native QAM
            // protocol, restore the keys it actually needs at that time.
            // Signal below this RMS is treated as silence.
            silenceThreshold: 1e-3,
            // Hangup detection: consecutive silent packets before declaring
            // call lost. 750 × 20ms = 15 seconds. Increase if your BBS has
            // long pauses between screens.
            silenceHangupPackets: 750,
            // Per-protocol carrier frequencies (Hz). These match ITU-T specs
            // but can be tweaked for gateway quirks.
            // V22bis and V23 entries kept for the TESTING-status classes;
            // V32bis and V34 entries dropped with those protocols.
            carriers: {
              V21: {
                // Channel 1 (originating modem)
                ch1Mark: 1280,
                ch1Space: 1080,
                // Channel 2 (answering modem)
                ch2Mark: 2100,
                ch2Space: 1750
              },
              V22: {
                // Both use 1200 Hz carrier, DPSK
                origCarrier: 1200,
                answerCarrier: 2400
              },
              V22bis: {
                // TESTING
                origCarrier: 1200,
                answerCarrier: 2400
              },
              V23: {
                // TESTING
                // Forward channel: 1200 bps
                forwardMark: 1300,
                forwardSpace: 2100,
                // Backward channel: 75 bps
                backwardMark: 390,
                backwardSpace: 450
              }
            }
          },
          // ─────────────────────────────────────────────────────────────────
          // slmodemd-pjsip — options for backend === 'slmodemd-pjsip'
          // ─────────────────────────────────────────────────────────────────
          //
          // Silently ignored when backend === 'native'.
          //
          // The slmodemd-pjsip backend boots a minimal QEMU i386 VM running
          // (in order, inside the guest):
          //   * slmodemd       (the DSP)
          //   * d-modem        (PJSIP pjmedia_port subclass that bridges
          //                    PJSIP audio frames to slmodemd's socketpair)
          //   * modemd-tunnel  (UDP-over-TCP transport for SIP/RTP between
          //                    Node and the guest)
          //   * modemd-ctrl    (PTY ↔ control-channel bridge so Node can
          //                    drive AT commands and exchange data-mode
          //                    bytes with slmodemd)
          //
          // Node terminates the external SIP/RTP leg, then INVITEs d-modem
          // inside the VM as a B2BUA — see PJSIP.md for the design
          // rationale and slmodemd-pjsip.md for the implementation manual.
          "slmodemd-pjsip": {
            // ── QEMU launch ──────────────────────────────────────────────
            qemu: {
              // Path to qemu-system-i386. If null, falls back to QEMU_SYSTEM_I386
              // env var, then a PATH lookup at spawn.
              // Windows: typical install path. Linux/macOS: usually just leave
              // null and put qemu-system-i386 on PATH.
              qemuPath: QEMU_PATH,
              // Kernel image (bzImage). Absolute or relative to repo root.
              kernelPath: "./vm/images/bzImage",
              // Initramfs. NOTE: src/index.js currently hardcodes the
              // slmodemd-pjsip rootfs path for the runtime launch, so this
              // key is unused at runtime. Retained for any future caller
              // that wants to override.
              initrdPath: "./vm/images/rootfs-slmodemd-pjsip.cpio.gz",
              // Guest RAM in MB. 256 is generous; slmodemd itself needs much
              // less, but PJSIP's pool allocators want headroom.
              vmMemoryMb: 256,
              // Accelerator: 'kvm' (Linux), 'hvf' (macOS), 'whpx' (Windows),
              // 'tcg' (everywhere, software emulation). null = autodetect.
              // Forcing 'tcg' is useful in CI sandboxes without
              // virtualization access.
              vmAccel: VM_ACCEL,
              // Extra tokens appended to the kernel cmdline. Mainly for
              // debug — the VM's init script doesn't read these, but they
              // show up in /proc/cmdline.
              vmAppendExtra: null
            },
            // ── Guest-side TCP transport (UDP-over-TCP tunnel) ───────────
            //
            // The VM talks to Node over two TCP loopback connections — one
            // carrying audio (RTP) datagrams, one carrying control messages
            // (AT commands, modem status, CONNECT/NO CARRIER lines). Node
            // listens; QEMU's chardev attaches outbound.
            //
            // Earlier iterations used Unix sockets on Linux and named pipes
            // on Windows; both caused platform-specific jitter / buffering
            // issues, especially on Windows where libuv suffered back-to-back
            // small-write corruption and tight kernel buffers. TCP loopback
            // is battle-tested in libuv and QEMU, has generous default
            // buffers (64-128 KB vs pipe ~4 KB), and with TCP_NODELAY set
            // on both ends has no coalescing gotchas.
            //
            // Defaults sit in a quiet zone between the well-known ports and
            // the OS ephemeral ranges (Linux 32768+, Windows 49152+), so
            // there's no risk of the OS pre-allocating them to unrelated
            // outbound sockets. Override only for local port conflicts,
            // running multiple synthmodem instances, or isolating a test run.
            //
            // Both ports must be 1024-65535 and different from each other.
            transport: {
              audioPort: AUDIO_PORT,
              controlPort: CONTROL_PORT,
              // Host interface to bind. Loopback-only by default — the VM
              // runs on the same machine as Node; there's no reason to
              // expose these ports to the network.
              bindHost: "127.0.0.1"
            },
            // ── Diagnostics ──────────────────────────────────────────────
            // Log level for processes inside the guest. Propagated via the
            // kernel cmdline (synthmodem_log=<level>) to S99modem-pjsip,
            // which exports it as SYNTHMODEM_LOG_LEVEL for d-modem and
            // modemd-ctrl to read.
            //   'error' — only errors (default; quiet startup)
            //   'info'  — connect/HELLO/AT-received traces
            //   'debug' — per-frame debug, including AT content
            logLevel: GUEST_LOG_LEVEL,
            // Where to put the ephemeral Unix sockets used by the qemu
            // chardev wiring. null = os.tmpdir().
            socketDir: null,
            // If set to a path, every byte QEMU emits on its combined
            // stdout+stderr (guest kernel console + guest userspace +
            // QEMU itself) is appended there. Useful for retroactive boot
            // diagnosis. null = no persistent log. The file is created in
            // append mode; rotate externally if it grows too large.
            bootLogPath: BOOT_LOG_PATH,
            // If set to a directory, when the VM exits uncleanly (non-zero
            // status or unexpected mid-session exit), the last 256 KB of the
            // boot log plus a small metadata sidecar are dumped there. Each
            // dump gets a timestamped filename. Runs even when bootLogPath
            // is null — the in-memory ring buffer is always available.
            crashDumpDir: null,
            // If true, log every wire frame crossing the Node ↔ guest
            // boundary (both directions) at trace level. VERY verbose — a
            // 60-second call emits tens of thousands of audio frames. Use
            // only for protocol-level debugging. Runs host-side; the guest
            // is unaware and unaffected.
            traceWireFrames: false,
            // ── Pre-ATA AT command sequence ──────────────────────────────
            //
            // Array of raw AT commands sent to slmodemd in order BEFORE the
            // automatic ATA. Leave empty (`atInit: []`) for normal operation
            // — slmodemd's defaults run a full V.8 handshake that virtually
            // every modern modem negotiates cleanly (V.34, V.90, V.92 over
            // V.8, with fallback to V.32bis / V.22bis / V.22 / V.21 as
            // needed).
            //
            // Use this only when you have a specific caller configuration
            // that needs an explicit modulation or rate bound. Each entry
            // is passed to slmodemd verbatim and must be a valid AT command
            // as accepted by slmodemd's command interpreter. slmodemd's
            // responses (OK / ERROR) are logged but do not halt the
            // sequence.
            //
            // Useful commands (see slmodemd's modem_at.c for the
            // authoritative list, and the D-Modem README for real-world
            // examples):
            //
            //   AT+MS=<modulation>[,<automode>[,<minrate>[,<maxrate>]]]
            //     Select modulation family and rate window.
            //     modulation: 11=V.21, 22=V.22, 24=V.22bis, 32=V.32,
            //                 132=V.32bis, 138=V.34, 56=K56flex, 90=V.90,
            //                 92=V.92
            //     automode:   0 = disable V.8 (use this modulation directly);
            //                 1 = allow V.8 to pick among capable modulations
            //     Examples:
            //       'AT+MS=132,0,4800,9600'  — V.32bis only, 4800-9600 bps
            //       'AT+MS=138,1,9600,33600' — V.34 preferred via V.8, up to 33.6k
            //       'AT+MS=24,0,1200,2400'   — V.22bis only, 1200-2400 bps
            //
            //   ATS<reg>=<value>
            //     Set an S-register. Most useful:
            //       S7  = wait-for-carrier timeout (seconds)
            //       S10 = carrier-loss disconnect threshold
            //       S38 = V.42 ODP timeout
            //
            //   AT&K<n>   flow control     (0=none, 3=RTS/CTS, 4=XON/XOFF)
            //   AT\N<n>   error correction (0=normal, 3=V.42/MNP, 5=V.42/MNP required)
            //   AT%C<n>   compression      (0=disabled, 3=V.42bis/MNP5)
            //   ATS0=<n>  rings before auto-answer (we already answer via
            //             ATA, so usually irrelevant)
            //
            // Example (V.32bis, 4800-9600 bps only, no error correction):
            //   atInit: ['AT&K3', 'AT+MS=132,0,4800,9600']
            //
            // Example (force V.22 for a V.22-locked caller):
            //   atInit: ['AT+MS=22,0,1200,1200']
            //
            // Errors on any command are logged but do NOT stop the
            // sequence, because some slmodemd builds emit ERROR on command
            // forms that still had the intended side-effect, and we'd
            // rather try ATA than abandon the call at init time.
            atInit: AT_INIT
          }
        },
        // ─────────────────────────────────────────────────────────────────────────────
        // TELNET PROXY
        // ─────────────────────────────────────────────────────────────────────────────
        telnet: {
          // TCP connect timeout (ms)
          connectTimeoutMs: 1e4,
          // Idle timeout — close connection after this many ms of no data (0 = disabled)
          idleTimeoutMs: 3e5,
          // 5 minutes
          // Buffer size for proxy chunks (bytes)
          bufferSize: 4096,
          // Send IAC WILL ECHO / DO SUPPRESS-GO-AHEAD during telnet negotiation
          negotiateOptions: true,
          // Terminal type to advertise during TTYPE negotiation
          terminalType: "VT100",
          // Terminal dimensions to advertise via NAWS
          terminalCols: 80,
          terminalRows: 24,
          // Allowed hosts (CIDR or hostname patterns). Empty array = allow all.
          // Example: ['192.168.0.0/16', '*.example.com']
          allowedHosts: [],
          // Blocked hosts
          blockedHosts: ["169.254.169.254"],
          // block AWS metadata etc.
          // DNS resolve timeout (ms)
          dnsTimeoutMs: 5e3,
          // CONNECT> menu-idle UART heartbeat. When the user is sitting at the
          // CONNECT> prompt and no data is flowing in either direction, send a
          // single CR (0x0D) every this many ms to keep the receiving modem's
          // UART framer (and indirectly its descrambler) resynced. CR is
          // visually inert on the user's terminal — it just moves the cursor
          // to column 0. Set to 0 to disable. See TelnetProxy._scheduleMenuHeartbeat
          // for the full rationale; in short, pure V.22 scrambled-marking idle
          // looks like random bits to a hardware modem's UART, which can
          // misframe and produce visible-but-bogus characters on the terminal
          // until something resyncs it. The heartbeat does NOT run during a
          // proxied BBS session — real BBS data already exercises the UART.
          menuIdleHeartbeatMs: 0
        },
        // ─────────────────────────────────────────────────────────────────────────────
        // TERMINAL UI (the menu shown to connected modem users)
        // ─────────────────────────────────────────────────────────────────────────────
        terminal: {
          // Greeting banner (shown after modem connect, before the prompt).
          //
          // Supports placeholders that are substituted at attach time using
          // the connection details reported by the modem backend:
          //   {{protocol}}  e.g. 'V32bis', 'V22bis', 'Bell103', 'V34'
          //   {{bps}}       e.g. '14400', '2400', '300', '19200'
          //
          // Example using placeholders:
          //   banner: [
          //     '',
          //     '  CONNECT {{bps}} ({{protocol}})',
          //     '  Welcome to SynthModem',
          //     '',
          //   ].join('\r\n'),
          //
          // If a placeholder appears but the connect info is unavailable
          // for some reason, it renders as 'unknown' / '0' rather than
          // leaving the literal `{{protocol}}` visible.
          banner: [
            "",
            "+-----------------------------------+",
            "|        S Y N T H M O D E M        |",
            "|           Telnet Gateway          |",
            "+-----------------------------------+",
            "",
            "Connected using {{protocol}} @ {{bps}} bps.",
            "",
            "Type <host> or <host>:<port> to connect.",
            "Type QUIT to disconnect.",
            "",
            ""
          ].join("\r\n"),
          // banner: [ 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' ],
          // Prompt string
          prompt: "CONNECT> ",
          // Default telnet port if none specified
          defaultPort: 23,
          // Echo typed characters back to user
          localEcho: true,
          // Line ending to send to modem client (\r\n for modems, \n for unix)
          lineEnding: "\r\n",
          // Maximum input line length
          maxInputLength: 256
        },
        // ─────────────────────────────────────────────────────────────────────────────
        // LOGGING
        // ─────────────────────────────────────────────────────────────────────────────
        logging: {
          // Log levels: 'error', 'warn', 'info', 'debug', 'trace'
          level: LOG_LEVEL,
          // Log SIP message bodies (can be verbose)
          logSipMessages: true,
          // Log RTP packet events (very verbose — only for low-level debugging)
          logRtpPackets: false,
          // Log DSP state transitions
          logDspState: true,
          // Log raw modem data bytes (hex)
          logModemData: false,
          // Timestamp format: 'iso', 'unix', 'relative'
          timestampFormat: "iso",
          // Colour output (disable if piping to file)
          colorize: true
        },
        // ─────────────────────────────────────────────────────────────────────────────
        // TEST CLIENT
        // ─────────────────────────────────────────────────────────────────────────────
        testClient: {
          // SIP server to call
          serverHost: "127.0.0.1",
          serverPort: 5060,
          serverTransport: "udp",
          // 'udp' or 'tcp'
          // From URI for the outbound call
          fromUser: "testmodem",
          fromDomain: "testclient.local",
          // Number/URI to dial
          toUser: "modem",
          toDomain: "127.0.0.1",
          // Local SIP port for the test client UAC
          localSipPort: 5061,
          // Local RTP port for the test client
          localRtpPort: 2e4,
          // Which modem protocol to originate with
          // 'auto' = use V.8 negotiation, or specify e.g. 'V22'
          originateProtocol: "auto",
          // Local speaker playback was removed from the test client in
          // cleanup-phase-2 (the underlying `speaker` npm package had a
          // security advisory and was the last reason the test client
          // pulled in a native build dependency). The audioOutput,
          // audioOutputDevice, and audioOutputVolume keys that previously
          // lived here are gone with it.
          // After connect: automatically send this string as if typed
          // (useful for scripted testing). null = interactive mode.
          autoConnect: null,
          // e.g. 'bbs.example.com:23'
          // Timeout waiting for CONNECT from answering modem (ms)
          connectTimeoutMs: 6e4,
          // Display raw modem state transitions in the test client
          verbose: true
        }
      };
    }
  });

  // vendor/synthlink-config.js
  var require_synthlink_config = __commonJS({
    "vendor/synthlink-config.js"(exports, module) {
      "use strict";
      var config = require_config();
      config.modem.native.protocolPreference = ["V21"];
      config.modem.native.v8ModulationModes = ["V21"];
      config.modem.native.v22MagOnlyDetect = true;
      config.modem.native.cdStableMs = 120;
      config.modem.native.listenWindowMs = 12e3;
      config.modem.native.skipCdVerification = true;
      config.logging = config.logging || {};
      config.logging.level = "warn";
      module.exports = config;
    }
  });

  // node_modules/events/events.js
  var require_events = __commonJS({
    "node_modules/events/events.js"(exports, module) {
      "use strict";
      var R = typeof Reflect === "object" ? Reflect : null;
      var ReflectApply = R && typeof R.apply === "function" ? R.apply : function ReflectApply2(target, receiver, args) {
        return Function.prototype.apply.call(target, receiver, args);
      };
      var ReflectOwnKeys;
      if (R && typeof R.ownKeys === "function") {
        ReflectOwnKeys = R.ownKeys;
      } else if (Object.getOwnPropertySymbols) {
        ReflectOwnKeys = function ReflectOwnKeys2(target) {
          return Object.getOwnPropertyNames(target).concat(Object.getOwnPropertySymbols(target));
        };
      } else {
        ReflectOwnKeys = function ReflectOwnKeys2(target) {
          return Object.getOwnPropertyNames(target);
        };
      }
      function ProcessEmitWarning(warning) {
        if (console && console.warn) console.warn(warning);
      }
      var NumberIsNaN = Number.isNaN || function NumberIsNaN2(value) {
        return value !== value;
      };
      function EventEmitter() {
        EventEmitter.init.call(this);
      }
      module.exports = EventEmitter;
      module.exports.once = once;
      EventEmitter.EventEmitter = EventEmitter;
      EventEmitter.prototype._events = void 0;
      EventEmitter.prototype._eventsCount = 0;
      EventEmitter.prototype._maxListeners = void 0;
      var defaultMaxListeners = 10;
      function checkListener(listener) {
        if (typeof listener !== "function") {
          throw new TypeError('The "listener" argument must be of type Function. Received type ' + typeof listener);
        }
      }
      Object.defineProperty(EventEmitter, "defaultMaxListeners", {
        enumerable: true,
        get: function() {
          return defaultMaxListeners;
        },
        set: function(arg) {
          if (typeof arg !== "number" || arg < 0 || NumberIsNaN(arg)) {
            throw new RangeError('The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received ' + arg + ".");
          }
          defaultMaxListeners = arg;
        }
      });
      EventEmitter.init = function() {
        if (this._events === void 0 || this._events === Object.getPrototypeOf(this)._events) {
          this._events = /* @__PURE__ */ Object.create(null);
          this._eventsCount = 0;
        }
        this._maxListeners = this._maxListeners || void 0;
      };
      EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
        if (typeof n !== "number" || n < 0 || NumberIsNaN(n)) {
          throw new RangeError('The value of "n" is out of range. It must be a non-negative number. Received ' + n + ".");
        }
        this._maxListeners = n;
        return this;
      };
      function _getMaxListeners(that) {
        if (that._maxListeners === void 0)
          return EventEmitter.defaultMaxListeners;
        return that._maxListeners;
      }
      EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
        return _getMaxListeners(this);
      };
      EventEmitter.prototype.emit = function emit(type) {
        var args = [];
        for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
        var doError = type === "error";
        var events = this._events;
        if (events !== void 0)
          doError = doError && events.error === void 0;
        else if (!doError)
          return false;
        if (doError) {
          var er;
          if (args.length > 0)
            er = args[0];
          if (er instanceof Error) {
            throw er;
          }
          var err = new Error("Unhandled error." + (er ? " (" + er.message + ")" : ""));
          err.context = er;
          throw err;
        }
        var handler = events[type];
        if (handler === void 0)
          return false;
        if (typeof handler === "function") {
          ReflectApply(handler, this, args);
        } else {
          var len = handler.length;
          var listeners = arrayClone(handler, len);
          for (var i = 0; i < len; ++i)
            ReflectApply(listeners[i], this, args);
        }
        return true;
      };
      function _addListener(target, type, listener, prepend) {
        var m;
        var events;
        var existing;
        checkListener(listener);
        events = target._events;
        if (events === void 0) {
          events = target._events = /* @__PURE__ */ Object.create(null);
          target._eventsCount = 0;
        } else {
          if (events.newListener !== void 0) {
            target.emit(
              "newListener",
              type,
              listener.listener ? listener.listener : listener
            );
            events = target._events;
          }
          existing = events[type];
        }
        if (existing === void 0) {
          existing = events[type] = listener;
          ++target._eventsCount;
        } else {
          if (typeof existing === "function") {
            existing = events[type] = prepend ? [listener, existing] : [existing, listener];
          } else if (prepend) {
            existing.unshift(listener);
          } else {
            existing.push(listener);
          }
          m = _getMaxListeners(target);
          if (m > 0 && existing.length > m && !existing.warned) {
            existing.warned = true;
            var w = new Error("Possible EventEmitter memory leak detected. " + existing.length + " " + String(type) + " listeners added. Use emitter.setMaxListeners() to increase limit");
            w.name = "MaxListenersExceededWarning";
            w.emitter = target;
            w.type = type;
            w.count = existing.length;
            ProcessEmitWarning(w);
          }
        }
        return target;
      }
      EventEmitter.prototype.addListener = function addListener(type, listener) {
        return _addListener(this, type, listener, false);
      };
      EventEmitter.prototype.on = EventEmitter.prototype.addListener;
      EventEmitter.prototype.prependListener = function prependListener(type, listener) {
        return _addListener(this, type, listener, true);
      };
      function onceWrapper() {
        if (!this.fired) {
          this.target.removeListener(this.type, this.wrapFn);
          this.fired = true;
          if (arguments.length === 0)
            return this.listener.call(this.target);
          return this.listener.apply(this.target, arguments);
        }
      }
      function _onceWrap(target, type, listener) {
        var state = { fired: false, wrapFn: void 0, target, type, listener };
        var wrapped = onceWrapper.bind(state);
        wrapped.listener = listener;
        state.wrapFn = wrapped;
        return wrapped;
      }
      EventEmitter.prototype.once = function once2(type, listener) {
        checkListener(listener);
        this.on(type, _onceWrap(this, type, listener));
        return this;
      };
      EventEmitter.prototype.prependOnceListener = function prependOnceListener(type, listener) {
        checkListener(listener);
        this.prependListener(type, _onceWrap(this, type, listener));
        return this;
      };
      EventEmitter.prototype.removeListener = function removeListener(type, listener) {
        var list, events, position, i, originalListener;
        checkListener(listener);
        events = this._events;
        if (events === void 0)
          return this;
        list = events[type];
        if (list === void 0)
          return this;
        if (list === listener || list.listener === listener) {
          if (--this._eventsCount === 0)
            this._events = /* @__PURE__ */ Object.create(null);
          else {
            delete events[type];
            if (events.removeListener)
              this.emit("removeListener", type, list.listener || listener);
          }
        } else if (typeof list !== "function") {
          position = -1;
          for (i = list.length - 1; i >= 0; i--) {
            if (list[i] === listener || list[i].listener === listener) {
              originalListener = list[i].listener;
              position = i;
              break;
            }
          }
          if (position < 0)
            return this;
          if (position === 0)
            list.shift();
          else {
            spliceOne(list, position);
          }
          if (list.length === 1)
            events[type] = list[0];
          if (events.removeListener !== void 0)
            this.emit("removeListener", type, originalListener || listener);
        }
        return this;
      };
      EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
      EventEmitter.prototype.removeAllListeners = function removeAllListeners(type) {
        var listeners, events, i;
        events = this._events;
        if (events === void 0)
          return this;
        if (events.removeListener === void 0) {
          if (arguments.length === 0) {
            this._events = /* @__PURE__ */ Object.create(null);
            this._eventsCount = 0;
          } else if (events[type] !== void 0) {
            if (--this._eventsCount === 0)
              this._events = /* @__PURE__ */ Object.create(null);
            else
              delete events[type];
          }
          return this;
        }
        if (arguments.length === 0) {
          var keys = Object.keys(events);
          var key;
          for (i = 0; i < keys.length; ++i) {
            key = keys[i];
            if (key === "removeListener") continue;
            this.removeAllListeners(key);
          }
          this.removeAllListeners("removeListener");
          this._events = /* @__PURE__ */ Object.create(null);
          this._eventsCount = 0;
          return this;
        }
        listeners = events[type];
        if (typeof listeners === "function") {
          this.removeListener(type, listeners);
        } else if (listeners !== void 0) {
          for (i = listeners.length - 1; i >= 0; i--) {
            this.removeListener(type, listeners[i]);
          }
        }
        return this;
      };
      function _listeners(target, type, unwrap) {
        var events = target._events;
        if (events === void 0)
          return [];
        var evlistener = events[type];
        if (evlistener === void 0)
          return [];
        if (typeof evlistener === "function")
          return unwrap ? [evlistener.listener || evlistener] : [evlistener];
        return unwrap ? unwrapListeners(evlistener) : arrayClone(evlistener, evlistener.length);
      }
      EventEmitter.prototype.listeners = function listeners(type) {
        return _listeners(this, type, true);
      };
      EventEmitter.prototype.rawListeners = function rawListeners(type) {
        return _listeners(this, type, false);
      };
      EventEmitter.listenerCount = function(emitter, type) {
        if (typeof emitter.listenerCount === "function") {
          return emitter.listenerCount(type);
        } else {
          return listenerCount.call(emitter, type);
        }
      };
      EventEmitter.prototype.listenerCount = listenerCount;
      function listenerCount(type) {
        var events = this._events;
        if (events !== void 0) {
          var evlistener = events[type];
          if (typeof evlistener === "function") {
            return 1;
          } else if (evlistener !== void 0) {
            return evlistener.length;
          }
        }
        return 0;
      }
      EventEmitter.prototype.eventNames = function eventNames() {
        return this._eventsCount > 0 ? ReflectOwnKeys(this._events) : [];
      };
      function arrayClone(arr, n) {
        var copy = new Array(n);
        for (var i = 0; i < n; ++i)
          copy[i] = arr[i];
        return copy;
      }
      function spliceOne(list, index) {
        for (; index + 1 < list.length; index++)
          list[index] = list[index + 1];
        list.pop();
      }
      function unwrapListeners(arr) {
        var ret = new Array(arr.length);
        for (var i = 0; i < ret.length; ++i) {
          ret[i] = arr[i].listener || arr[i];
        }
        return ret;
      }
      function once(emitter, name) {
        return new Promise(function(resolve, reject) {
          function errorListener(err) {
            emitter.removeListener(name, resolver);
            reject(err);
          }
          function resolver() {
            if (typeof emitter.removeListener === "function") {
              emitter.removeListener("error", errorListener);
            }
            resolve([].slice.call(arguments));
          }
          ;
          eventTargetAgnosticAddListener(emitter, name, resolver, { once: true });
          if (name !== "error") {
            addErrorHandlerIfEventEmitter(emitter, errorListener, { once: true });
          }
        });
      }
      function addErrorHandlerIfEventEmitter(emitter, handler, flags) {
        if (typeof emitter.on === "function") {
          eventTargetAgnosticAddListener(emitter, "error", handler, flags);
        }
      }
      function eventTargetAgnosticAddListener(emitter, name, listener, flags) {
        if (typeof emitter.on === "function") {
          if (flags.once) {
            emitter.once(name, listener);
          } else {
            emitter.on(name, listener);
          }
        } else if (typeof emitter.addEventListener === "function") {
          emitter.addEventListener(name, function wrapListener(arg) {
            if (flags.once) {
              emitter.removeEventListener(name, wrapListener);
            }
            listener(arg);
          });
        } else {
          throw new TypeError('The "emitter" argument must be of type EventEmitter. Received type ' + typeof emitter);
        }
      }
    }
  });

  // vendor/src/logger.js
  var require_logger = __commonJS({
    "vendor/src/logger.js"(exports, module) {
      "use strict";
      var config = require_config();
      var LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
      function activeLevel() {
        const l = config.logging && config.logging.level || "warn";
        return LEVELS[l] == null ? 1 : LEVELS[l];
      }
      function makeLogger(tag) {
        const emit = (lvl, args) => {
          if (LEVELS[lvl] > activeLevel()) return;
          const line = `[${lvl.toUpperCase()}] [${tag}] ` + args.join(" ");
          if (typeof process !== "undefined" && process.stdout && process.stdout.write) {
            process.stdout.write(line + "\n");
          } else if (typeof console !== "undefined") {
            (console[lvl] || console.log)(line);
          }
        };
        return {
          error: (...a) => emit("error", a),
          warn: (...a) => emit("warn", a),
          info: (...a) => emit("info", a),
          debug: (...a) => emit("debug", a),
          trace: (...a) => emit("trace", a)
        };
      }
      module.exports = { makeLogger };
    }
  });

  // vendor/src/dsp/Primitives.js
  var require_Primitives = __commonJS({
    "vendor/src/dsp/Primitives.js"(exports, module) {
      "use strict";
      var TWO_PI = Math.PI * 2;
      var NCO = class {
        constructor(sampleRate) {
          this._sr = sampleRate;
          this._phase = 0;
          this._freq = 0;
          this._phaseInc = 0;
        }
        setFrequency(hz) {
          this._freq = hz;
          this._phaseInc = TWO_PI * hz / this._sr;
        }
        /** Advance by one sample, return [cos, sin] */
        tick() {
          const c = Math.cos(this._phase);
          const s = Math.sin(this._phase);
          this._phase = (this._phase + this._phaseInc) % TWO_PI;
          return [c, s];
        }
        /** Generate n samples of cosine into out[], starting at offset */
        fill(out, n, offset = 0) {
          for (let i = 0; i < n; i++) {
            out[offset + i] = Math.cos(this._phase);
            this._phase = (this._phase + this._phaseInc) % TWO_PI;
          }
        }
        /** Adjust phase by delta radians (used by Costas loop) */
        adjustPhase(delta) {
          this._phase = (this._phase + delta) % TWO_PI;
        }
        setPhase(p) {
          this._phase = p % TWO_PI;
        }
        get phase() {
          return this._phase;
        }
        get freq() {
          return this._freq;
        }
      };
      var SinglePoleLPF = class {
        constructor(alpha) {
          this._alpha = alpha;
          this._y = 0;
        }
        process(x) {
          this._y += this._alpha * (x - this._y);
          return this._y;
        }
        reset() {
          this._y = 0;
        }
        get value() {
          return this._y;
        }
      };
      var BiquadFilter = class _BiquadFilter {
        constructor(b0, b1, b2, a1, a2) {
          this.b0 = b0;
          this.b1 = b1;
          this.b2 = b2;
          this.a1 = a1;
          this.a2 = a2;
          this.w1 = 0;
          this.w2 = 0;
        }
        process(x) {
          const w = x - this.a1 * this.w1 - this.a2 * this.w2;
          const y = this.b0 * w + this.b1 * this.w1 + this.b2 * this.w2;
          this.w2 = this.w1;
          this.w1 = w;
          return y;
        }
        processBlock(input, output, n) {
          for (let i = 0; i < n; i++) output[i] = this.process(input[i]);
        }
        reset() {
          this.w1 = 0;
          this.w2 = 0;
        }
        static makeLowPass(fc, Q, sr) {
          const omega = TWO_PI * fc / sr;
          const sn = Math.sin(omega), cs = Math.cos(omega);
          const alpha = sn / (2 * Q);
          const b0 = (1 - cs) / 2, b1 = 1 - cs, b2 = b0;
          const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
          return new _BiquadFilter(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
        }
        static makeBandPass(fc, Q, sr) {
          const omega = TWO_PI * fc / sr;
          const sn = Math.sin(omega), cs = Math.cos(omega);
          const alpha = sn / (2 * Q);
          const b0 = alpha, b1 = 0, b2 = -alpha;
          const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
          return new _BiquadFilter(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
        }
        static makeHighPass(fc, Q, sr) {
          const omega = TWO_PI * fc / sr;
          const sn = Math.sin(omega), cs = Math.cos(omega);
          const alpha = sn / (2 * Q);
          const b0 = (1 + cs) / 2, b1 = -(1 + cs), b2 = b0;
          const a0 = 1 + alpha, a1 = -2 * cs, a2 = 1 - alpha;
          return new _BiquadFilter(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
        }
      };
      var AGC = class {
        constructor(cfg) {
          this._target = cfg.agcTargetLevel;
          this._gain = 1;
          this._sqSum = 0;
          this._count = 0;
          this._blockSize = 960;
          this._stepSize = 0.01;
        }
        process(samples) {
          const out = new Float32Array(samples.length);
          for (let i = 0; i < samples.length; i++) {
            const y = samples[i] * this._gain;
            out[i] = y < -1 ? -1 : y > 1 ? 1 : y;
            this._sqSum += samples[i] * samples[i];
            if (++this._count >= this._blockSize) {
              const rms2 = Math.sqrt(this._sqSum / this._count);
              if (rms2 > 1e-5) {
                const desired = this._target / rms2;
                this._gain *= 1 + (desired / this._gain - 1) * this._stepSize;
                this._gain = Math.max(0.1, Math.min(10, this._gain));
              }
              this._sqSum = 0;
              this._count = 0;
            }
          }
          return out;
        }
        get gain() {
          return this._gain;
        }
      };
      var CostasLoop = class {
        constructor(nominalFreq, sampleRate, loopBw = 0.01) {
          this._sr = sampleRate;
          this._nco = new NCO(sampleRate);
          this._nco.setFrequency(nominalFreq);
          this._lpI = new SinglePoleLPF(0.1);
          this._lpQ = new SinglePoleLPF(0.1);
          this._alpha = loopBw;
          this._beta = loopBw * loopBw / 4;
          this._freqAdj = 0;
        }
        /**
         * Process one sample.
         * @returns {{ i: number, q: number }}
         */
        process(x) {
          const [ci, cq] = this._nco.tick();
          const i = x * ci;
          const q = -x * cq;
          const iLp = this._lpI.process(i);
          const qLp = this._lpQ.process(q);
          const err = (iLp > 0 ? 1 : -1) * qLp - (qLp > 0 ? 1 : -1) * iLp;
          this._freqAdj += this._beta * err;
          this._nco.adjustPhase(this._alpha * err);
          this._nco.setFrequency(this._nco.freq + this._freqAdj);
          return { i: iLp, q: qLp };
        }
        reset(freq) {
          if (freq !== void 0) this._nco.setFrequency(freq);
          this._lpI.reset();
          this._lpQ.reset();
          this._freqAdj = 0;
        }
      };
      var GardnerTiming = class {
        constructor(samplesPerSymbol, loopGain = 0.01) {
          this._sps = samplesPerSymbol;
          this._loopGain = loopGain;
          this._mu = 0;
          this._strobe = 0;
          this._prev = 0;
          this._mid = 0;
          this._symbols = [];
        }
        /**
         * Push samples in, get symbols out.
         * @param {number[]} samples
         * @returns {number[]} symbol decisions
         */
        process(samples) {
          const out = [];
          for (const x of samples) {
            this._strobe += 1;
            const frac = this._strobe - Math.floor(this._strobe);
            const interp = this._prev + frac * (x - this._prev);
            if (Math.floor(this._strobe) >= Math.round(this._sps / 2) && this._strobe < this._sps) {
              this._mid = interp;
            }
            if (this._strobe >= this._sps) {
              const sym = interp;
              const err = (this._prev - sym) * this._mid;
              this._mu -= this._loopGain * err;
              this._mu = Math.max(-0.5, Math.min(0.5, this._mu));
              this._sps = this._sps + this._mu;
              this._strobe -= Math.round(this._sps);
              out.push(sym);
            }
            this._prev = x;
          }
          return out;
        }
        reset() {
          this._mu = 0;
          this._strobe = 0;
          this._prev = 0;
          this._mid = 0;
        }
      };
      var LMSEqualizer = class {
        constructor(forwardTaps, stepSize, dfTaps = 0) {
          this._n = forwardTaps;
          this._dfTaps = dfTaps;
          this._mu = stepSize;
          this._wFwd = new Float64Array(forwardTaps);
          this._wFb = new Float64Array(dfTaps);
          this._bufFwd = new Float64Array(forwardTaps);
          this._bufFb = new Float64Array(dfTaps);
          this._wFwd[Math.floor(forwardTaps / 2)] = 1;
        }
        process(x, decision) {
          for (let i = this._n - 1; i > 0; i--) this._bufFwd[i] = this._bufFwd[i - 1];
          this._bufFwd[0] = x;
          let y = 0;
          for (let i = 0; i < this._n; i++) y += this._wFwd[i] * this._bufFwd[i];
          for (let i = 0; i < this._dfTaps; i++) y -= this._wFb[i] * this._bufFb[i];
          const d = decision !== void 0 ? decision : Math.sign(y);
          const err = d - y;
          for (let i = 0; i < this._n; i++) {
            this._wFwd[i] += this._mu * err * this._bufFwd[i];
          }
          if (this._dfTaps > 0) {
            for (let i = this._dfTaps - 1; i > 0; i--) this._bufFb[i] = this._bufFb[i - 1];
            this._bufFb[0] = d;
            for (let i = 0; i < this._dfTaps; i++) {
              this._wFb[i] += this._mu * err * this._bufFb[i];
            }
          }
          return y;
        }
        reset() {
          this._wFwd.fill(0);
          this._wFb.fill(0);
          this._wFwd[Math.floor(this._n / 2)] = 1;
          this._bufFwd.fill(0);
          this._bufFb.fill(0);
        }
      };
      var Scrambler = class {
        constructor(poly = [18, 23]) {
          this._poly = [...poly];
          this._maxTap = Math.max(...poly);
          this._reg = new Uint8Array(this._maxTap + 1);
        }
        scramble(bit) {
          let fb = bit;
          for (const t of this._poly) fb ^= this._reg[t - 1];
          for (let i = this._maxTap - 1; i > 0; i--) this._reg[i] = this._reg[i - 1];
          this._reg[0] = fb;
          return fb;
        }
        // Descrambler: in XOR taps (self-sync — uses incoming bits for feedback)
        descramble(bit) {
          let out = bit;
          for (const t of this._poly) out ^= this._reg[t - 1];
          for (let i = this._maxTap - 1; i > 0; i--) this._reg[i] = this._reg[i - 1];
          this._reg[0] = bit;
          return out;
        }
        reset() {
          this._reg.fill(0);
        }
      };
      function rms(samples) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        return Math.sqrt(sum / samples.length);
      }
      function generateTone(freq, durationMs, sampleRate, amplitude = 0.5) {
        const n = Math.round(durationMs * sampleRate / 1e3);
        const out = new Float32Array(n);
        const phaseInc = TWO_PI * freq / sampleRate;
        let phase = 0;
        for (let i = 0; i < n; i++) {
          out[i] = amplitude * Math.cos(phase);
          phase = (phase + phaseInc) % TWO_PI;
        }
        return out;
      }
      function generateANSam(durationMs, sampleRate, reversalIntervalMs, amplitude = 0.15) {
        const n = Math.round(durationMs * sampleRate / 1e3);
        const out = new Float32Array(n);
        const carrierInc = TWO_PI * 2100 / sampleRate;
        const amInc = TWO_PI * 15 / sampleRate;
        const avgAmp = amplitude / 1.2;
        let carrierPhase = 0;
        let amPhase = 0;
        const samplesPerReversal = Math.round(reversalIntervalMs * sampleRate / 1e3);
        let samplesUntilReversal = samplesPerReversal;
        for (let i = 0; i < n; i++) {
          const env = avgAmp * (1 + 0.2 * Math.sin(amPhase));
          out[i] = env * Math.cos(carrierPhase);
          carrierPhase = (carrierPhase + carrierInc) % TWO_PI;
          amPhase = (amPhase + amInc) % TWO_PI;
          if (--samplesUntilReversal <= 0) {
            carrierPhase = (carrierPhase + Math.PI) % TWO_PI;
            samplesUntilReversal = samplesPerReversal;
          }
        }
        return out;
      }
      function goertzel(samples, freq, sampleRate) {
        const k = Math.round(samples.length * freq / sampleRate);
        const omega = TWO_PI * k / samples.length;
        const coeff = 2 * Math.cos(omega);
        let s1 = 0, s2 = 0;
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i] + coeff * s1 - s2;
          s2 = s1;
          s1 = s;
        }
        return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.length;
      }
      function mix(a, b, gainA = 1, gainB = 1) {
        const len = Math.max(a.length, b.length);
        const out = new Float32Array(len);
        for (let i = 0; i < len; i++) {
          out[i] = (i < a.length ? a[i] * gainA : 0) + (i < b.length ? b[i] * gainB : 0);
        }
        return out;
      }
      function applyWindow(samples) {
        const n = samples.length;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const w = 0.5 * (1 - Math.cos(TWO_PI * i / (n - 1)));
          out[i] = samples[i] * w;
        }
        return out;
      }
      module.exports = {
        NCO,
        SinglePoleLPF,
        BiquadFilter,
        AGC,
        CostasLoop,
        GardnerTiming,
        LMSEqualizer,
        Scrambler,
        rms,
        generateTone,
        generateANSam,
        goertzel,
        mix,
        applyWindow,
        TWO_PI
      };
    }
  });

  // vendor/src/dsp/V8.js
  var require_V8 = __commonJS({
    "vendor/src/dsp/V8.js"(exports, module) {
      "use strict";
      var V8_SYNC_CI = "0000000001";
      var V8_SYNC_CM_JM = "0000001111";
      var V8_TAG_CALL_FN = [1, 0, 0, 0];
      var V8_TAG_MOD_MODES = [1, 0, 1, 0];
      var V8_CALLFN_DATA = [0, 1, 1];
      function packCategoryOctet(tag, optBits) {
        const b0 = tag[0], b1 = tag[1], b2 = tag[2], b3 = tag[3];
        const b4 = 0;
        const b5 = optBits[0], b6 = optBits[1], b7 = optBits[2];
        return [0, b0, b1, b2, b3, b4, b5, b6, b7, 1];
      }
      function packExtensionOctet(extBits) {
        const b0 = extBits[0], b1 = extBits[1], b2 = extBits[2];
        const b3 = 0;
        const b4 = 1;
        const b5 = 0;
        const b6 = extBits[3], b7 = extBits[4];
        return [0, b0, b1, b2, b3, b4, b5, b6, b7, 1];
      }
      function buildCallFunctionOctet() {
        return packCategoryOctet(V8_TAG_CALL_FN, V8_CALLFN_DATA);
      }
      function buildModulationModesOctets(modes = {}) {
        const modn0 = packCategoryOctet(V8_TAG_MOD_MODES, [
          modes.pcm ? 1 : 0,
          modes.v34 ? 1 : 0,
          modes.v34hd ? 1 : 0
        ]);
        const needModn1 = modes.v32bis || modes.v22bis || modes.v17 || modes.v29hd || modes.v27ter;
        const needModn2 = modes.v26ter || modes.v26bis || modes.v23 || modes.v23hd || modes.v21;
        const includeModn1 = needModn1 || needModn2;
        const includeModn2 = needModn2;
        const out = [...modn0];
        if (includeModn1) {
          const modn1 = packExtensionOctet([
            modes.v32bis ? 1 : 0,
            // b0
            modes.v22bis ? 1 : 0,
            // b1
            modes.v17 ? 1 : 0,
            // b2
            modes.v29hd ? 1 : 0,
            // b6
            modes.v27ter ? 1 : 0
            // b7
          ]);
          out.push(...modn1);
        }
        if (includeModn2) {
          const modn2 = packExtensionOctet([
            modes.v26ter ? 1 : 0,
            // b0
            modes.v26bis ? 1 : 0,
            // b1
            modes.v23 ? 1 : 0,
            // b2
            modes.v23hd ? 1 : 0,
            // b6
            modes.v21 ? 1 : 0
            // b7
          ]);
          out.push(...modn2);
        }
        return out;
      }
      function buildCI() {
        const bits = [];
        for (let i = 0; i < 10; i++) bits.push(1);
        for (const c of V8_SYNC_CI) bits.push(c === "1" ? 1 : 0);
        bits.push(...buildCallFunctionOctet());
        return bits;
      }
      function buildCMorJM(modes) {
        const bits = [];
        for (let i = 0; i < 10; i++) bits.push(1);
        for (const c of V8_SYNC_CM_JM) bits.push(c === "1" ? 1 : 0);
        bits.push(...buildCallFunctionOctet());
        bits.push(...buildModulationModesOctets(modes));
        return bits;
      }
      function buildCJ() {
        const bits = [];
        for (let i = 0; i < 3; i++) {
          bits.push(0);
          for (let j = 0; j < 8; j++) bits.push(0);
          bits.push(1);
        }
        return bits;
      }
      var V8Decoder = class {
        constructor() {
          this._bitBuf = [];
          this._maxBuf = 300;
          this._octetBits = [];
          this._octets = [];
          this._state = "HUNT";
          this._pendingType = null;
        }
        /**
         * Feed one bit. Returns a decoded message object when a complete one
         * is detected (triggered by either: seeing the start of the NEXT preamble
         * while in OCTETS state, OR calling finish()).
         *
         * Message: { type, octets[] }
         */
        feed(bit) {
          bit = bit & 1;
          this._bitBuf.push(bit);
          if (this._bitBuf.length > this._maxBuf) this._bitBuf.shift();
          if (this._state === "OCTETS" && this._bitBuf.length >= 20) {
            const last20 = this._bitBuf.slice(-20);
            if (this._matchesPreamble(last20, V8_SYNC_CI)) {
              const msg = this._emit();
              this._state = "OCTETS";
              this._pendingType = "CI";
              this._octets = [];
              this._octetBits = [];
              return msg;
            }
            if (this._matchesPreamble(last20, V8_SYNC_CM_JM)) {
              const msg = this._emit();
              this._state = "OCTETS";
              this._pendingType = "CM/JM";
              this._octets = [];
              this._octetBits = [];
              return msg;
            }
          }
          if (this._state === "HUNT") {
            if (this._bitBuf.length < 20) return null;
            const last20 = this._bitBuf.slice(-20);
            if (this._matchesPreamble(last20, V8_SYNC_CI)) {
              this._state = "OCTETS";
              this._pendingType = "CI";
              this._octets = [];
              this._octetBits = [];
            } else if (this._matchesPreamble(last20, V8_SYNC_CM_JM)) {
              this._state = "OCTETS";
              this._pendingType = "CM/JM";
              this._octets = [];
              this._octetBits = [];
            }
            return null;
          }
          this._octetBits.push(bit);
          if (this._octetBits.length === 10) {
            if (this._octetBits[0] !== 0 || this._octetBits[9] !== 1) {
              this._state = "HUNT";
              this._octets = [];
              this._octetBits = [];
              return null;
            }
            const b = this._octetBits.slice(1, 9);
            let v = 0;
            for (let i = 0; i < 8; i++) v |= (b[i] & 1) << i;
            this._octets.push(v);
            this._octetBits = [];
            if (this._pendingType === "CI") {
              const msg = this._emit();
              this._state = "HUNT";
              return msg;
            }
            if (this._octets.length >= 16) {
              const msg = this._emit();
              this._state = "HUNT";
              return msg;
            }
          }
          return null;
        }
        /**
         * Flush any pending message. Call this when the input stream ends,
         * or when you want to force-emit the current accumulation.
         */
        finish() {
          if (this._state === "OCTETS" && this._octets.length > 0) {
            const msg = this._emit();
            this._state = "HUNT";
            this._octets = [];
            this._octetBits = [];
            return msg;
          }
          return null;
        }
        _emit() {
          return { type: this._pendingType || "CM/JM", octets: this._octets.slice() };
        }
        _matchesPreamble(bits20, sync) {
          for (let i = 0; i < 10; i++) if (bits20[i] !== 1) return false;
          for (let i = 0; i < 10; i++) if (bits20[10 + i] !== (sync[i] === "1" ? 1 : 0)) return false;
          return true;
        }
      };
      function decodeModes(octets) {
        const modes = {};
        let i = 0;
        while (i < octets.length) {
          const o = octets[i];
          const b0 = o >> 0 & 1, b1 = o >> 1 & 1, b2 = o >> 2 & 1;
          const b3 = o >> 3 & 1, b4 = o >> 4 & 1, b5 = o >> 5 & 1;
          const b6 = o >> 6 & 1, b7 = o >> 7 & 1;
          if (b4 === 0) {
            const tag = b0 << 0 | b1 << 1 | b2 << 2 | b3 << 3;
            if (tag === 5) {
              modes.pcm = !!b5;
              modes.v34 = !!b6;
              modes.v34hd = !!b7;
              if (i + 1 < octets.length) {
                const o1 = octets[i + 1];
                const x_b3 = o1 >> 3 & 1, x_b4 = o1 >> 4 & 1, x_b5 = o1 >> 5 & 1;
                if (x_b3 === 0 && x_b4 === 1 && x_b5 === 0) {
                  modes.v32bis = !!(o1 >> 0 & 1);
                  modes.v22bis = !!(o1 >> 1 & 1);
                  modes.v17 = !!(o1 >> 2 & 1);
                  modes.v29hd = !!(o1 >> 6 & 1);
                  modes.v27ter = !!(o1 >> 7 & 1);
                  i++;
                  if (i + 1 < octets.length) {
                    const o2 = octets[i + 1];
                    const x2_b3 = o2 >> 3 & 1, x2_b4 = o2 >> 4 & 1, x2_b5 = o2 >> 5 & 1;
                    if (x2_b3 === 0 && x2_b4 === 1 && x2_b5 === 0) {
                      modes.v26ter = !!(o2 >> 0 & 1);
                      modes.v26bis = !!(o2 >> 1 & 1);
                      modes.v23 = !!(o2 >> 2 & 1);
                      modes.v23hd = !!(o2 >> 6 & 1);
                      modes.v21 = !!(o2 >> 7 & 1);
                      i++;
                    }
                  }
                }
              }
            } else if (tag === 1) {
              const callFn = b5 << 0 | b6 << 1 | b7 << 2;
              modes.callFn = callFn;
            }
          }
          i++;
        }
        return modes;
      }
      function selectProtocol(remote, preference) {
        const map = {
          V34: "v34",
          V32bis: "v32bis",
          V22bis: "v22bis",
          V22: "v22bis",
          // V.22 is included in V.22bis bit
          V23: "v23",
          V21: "v21"
        };
        for (const p of preference) {
          const key = map[p];
          if (key && remote[key]) return p;
        }
        return null;
      }
      var V8_BYTE_CI_SYNC = 0;
      var V8_BYTE_CMJM_SYNC = 224;
      function buildCIBytes() {
        return Buffer.from([V8_BYTE_CI_SYNC, 193]);
      }
      function _modModesBytes(modes) {
        let modn0 = 5;
        if (modes.pcm) modn0 |= 32;
        if (modes.v34) modn0 |= 64;
        if (modes.v34hd) modn0 |= 128;
        const needModn1 = modes.v32bis || modes.v22bis || modes.v17 || modes.v29hd || modes.v27ter;
        const needModn2 = modes.v26ter || modes.v26bis || modes.v23 || modes.v23hd || modes.v21;
        const out = [modn0];
        if (needModn1 || needModn2) {
          let modn1 = 16;
          if (modes.v32bis) modn1 |= 1;
          if (modes.v22bis) modn1 |= 2;
          if (modes.v17) modn1 |= 4;
          if (modes.v29hd) modn1 |= 64;
          if (modes.v27ter) modn1 |= 128;
          out.push(modn1);
        }
        if (needModn2) {
          let modn2 = 16;
          if (modes.v26ter) modn2 |= 1;
          if (modes.v26bis) modn2 |= 2;
          if (modes.v23) modn2 |= 4;
          if (modes.v23hd) modn2 |= 64;
          if (modes.v21) modn2 |= 128;
          out.push(modn2);
        }
        return out;
      }
      function buildCMBytes(modes) {
        return Buffer.from([V8_BYTE_CMJM_SYNC, 193, ..._modModesBytes(modes)]);
      }
      function buildJMBytes(modes) {
        return Buffer.from([V8_BYTE_CMJM_SYNC, 193, ..._modModesBytes(modes)]);
      }
      function buildCJBytes() {
        return Buffer.from([0, 0, 0]);
      }
      function parseV8Bytes(state, newBytes) {
        if (!state.buf) state.buf = Buffer.alloc(0);
        state.buf = Buffer.concat([state.buf, Buffer.from(newBytes)]);
        const msgs = [];
        while (state.buf.length > 0) {
          const b0 = state.buf[0];
          if (b0 === V8_BYTE_CI_SYNC) {
            if (state.buf.length < 2) return msgs;
            const b1 = state.buf[1];
            if (b1 === 0) {
              if (state.buf.length < 2) return msgs;
              if (state.buf.length >= 3 && state.buf[2] === 0) {
                msgs.push({ type: "CJ" });
                state.buf = state.buf.subarray(3);
                continue;
              }
              msgs.push({ type: "CJ" });
              state.buf = state.buf.subarray(2);
              continue;
            }
            if ((b1 & 31) !== 1) {
              state.buf = state.buf.subarray(1);
              continue;
            }
            const callFn = b1 >> 5 & 1 | (b1 >> 6 & 1) << 1 | (b1 >> 7 & 1) << 2;
            msgs.push({ type: "CI", callFn });
            state.buf = state.buf.subarray(2);
            continue;
          }
          if (b0 === V8_BYTE_CMJM_SYNC) {
            if (state.buf.length < 4) return msgs;
            const callFnByte = state.buf[1];
            const callFnValid = (callFnByte & 31) === 1;
            if (!callFnValid) {
              state.buf = state.buf.subarray(1);
              continue;
            }
            const callFn = callFnByte >> 5 & 1 | (callFnByte >> 6 & 1) << 1 | (callFnByte >> 7 & 1) << 2;
            const modn0 = state.buf[2];
            if ((modn0 & 31) !== 5) {
              state.buf = state.buf.subarray(1);
              continue;
            }
            const octets = [];
            let i = 2;
            while (i < state.buf.length && octets.length < 6) {
              const v = state.buf[i];
              if (v === V8_BYTE_CMJM_SYNC || v === 0) {
                break;
              }
              octets.push(v);
              i++;
            }
            const hitTerminator = i < state.buf.length && (state.buf[i] === V8_BYTE_CMJM_SYNC || state.buf[i] === 0);
            const sawEnoughOctets = octets.length >= 4;
            if (!hitTerminator && !sawEnoughOctets) {
              return msgs;
            }
            while (octets.length > 3) octets.pop();
            const consume = 2 + octets.length;
            const modes = decodeModesFromBytes(octets);
            modes.callFn = callFn;
            const rawBytes = Buffer.from(state.buf.subarray(0, consume));
            msgs.push({ type: "CM/JM", callFn, modes, bytes: rawBytes });
            state.buf = state.buf.subarray(consume);
            continue;
          }
          state.buf = state.buf.subarray(1);
        }
        return msgs;
      }
      function decodeModesFromBytes(octets) {
        const modes = {
          v34: false,
          v34hd: false,
          pcm: false,
          v32bis: false,
          v22bis: false,
          v17: false,
          v29hd: false,
          v27ter: false,
          v26ter: false,
          v26bis: false,
          v23: false,
          v23hd: false,
          v21: false
        };
        if (octets.length === 0) return modes;
        const modn0 = octets[0];
        if ((modn0 & 31) === 5) {
          modes.pcm = !!(modn0 & 32);
          modes.v34 = !!(modn0 & 64);
          modes.v34hd = !!(modn0 & 128);
        }
        if (octets.length >= 2) {
          const modn1 = octets[1];
          if ((modn1 & 56) === 16) {
            modes.v32bis = !!(modn1 & 1);
            modes.v22bis = !!(modn1 & 2);
            modes.v17 = !!(modn1 & 4);
            modes.v29hd = !!(modn1 & 64);
            modes.v27ter = !!(modn1 & 128);
          }
        }
        if (octets.length >= 3) {
          const modn2 = octets[2];
          if ((modn2 & 56) === 16) {
            modes.v26ter = !!(modn2 & 1);
            modes.v26bis = !!(modn2 & 2);
            modes.v23 = !!(modn2 & 4);
            modes.v23hd = !!(modn2 & 64);
            modes.v21 = !!(modn2 & 128);
          }
        }
        return modes;
      }
      module.exports = {
        // Constants
        V8_SYNC_CI,
        V8_SYNC_CM_JM,
        V8_TAG_CALL_FN,
        V8_TAG_MOD_MODES,
        V8_CALLFN_DATA,
        // Bit-level builders (for raw-bit V.21 or analysis)
        buildCI,
        buildCMorJM,
        buildCJ,
        buildCallFunctionOctet,
        buildModulationModesOctets,
        packCategoryOctet,
        packExtensionOctet,
        // Byte-level API (for use with UART-framed V.21 .write(bytes) / 'data' events)
        buildCIBytes,
        buildCMBytes,
        buildJMBytes,
        buildCJBytes,
        parseV8Bytes,
        // Decoder
        V8Decoder,
        decodeModes,
        selectProtocol
      };
      if (__require.main === module) {
        let check = function(label, ok2, extra = "") {
          if (ok2) {
            pass++;
            console.log("  PASS  " + label);
          } else {
            fail++;
            console.log("  FAIL  " + label + (extra ? ": " + extra : ""));
          }
        };
        let pass = 0, fail = 0;
        console.log("\n\u2550\u2550\u2550 V.8 self-test \u2550\u2550\u2550\n");
        console.log('Test 1: call-function octet (Data = "011" option bits)');
        const callFn = buildCallFunctionOctet();
        const expected = [0, 1, 0, 0, 0, 0, 0, 1, 1, 1];
        const ok = callFn.length === 10 && callFn.every((b, i) => b === expected[i]);
        check(
          "call-fn data octet matches spec Table 3",
          ok,
          "got " + callFn.join("")
        );
        console.log("\nTest 2: modulation-modes octet for {v32bis}");
        const mm = buildModulationModesOctets({ v32bis: true });
        const expMm = [
          0,
          1,
          0,
          1,
          0,
          0,
          0,
          0,
          0,
          1,
          0,
          1,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          1
        ];
        const okMm = mm.length === 20 && mm.every((b, i) => b === expMm[i]);
        check(
          "mod-modes {v32bis} produces modn0+modn1 matching Table 4",
          okMm,
          "got " + mm.join("")
        );
        console.log("\nTest 3: full CM sequence");
        const cm = buildCMorJM({ v32bis: true, v22bis: true, v21: true });
        check("CM length = 60 bits", cm.length === 60, "got " + cm.length);
        check("CM first 10 bits are all 1", cm.slice(0, 10).every((b) => b === 1));
        const syncExpected = V8_SYNC_CM_JM.split("").map((c) => c === "1" ? 1 : 0);
        check(
          'CM sync bits (positions 10-19) match "0000001111"',
          cm.slice(10, 20).every((b, i) => b === syncExpected[i])
        );
        console.log("\nTest 4: CJ terminator");
        const cj = buildCJ();
        check("CJ length = 30 bits (3 octets \xD7 10 bits each)", cj.length === 30);
        let cjOk = true;
        for (let g = 0; g < 3; g++) {
          const grp = cj.slice(g * 10, g * 10 + 10);
          if (grp[0] !== 0 || grp[9] !== 1) cjOk = false;
          for (let i = 1; i <= 8; i++) if (grp[i] !== 0) cjOk = false;
        }
        check("CJ 3 octets all-zero with framing", cjOk);
        console.log("\nTest 5: encode-then-decode CM round-trip");
        const modesIn = { v32bis: true, v22bis: true, v21: true };
        const encoded = buildCMorJM(modesIn);
        const dec = new V8Decoder();
        let msg = null;
        for (const b of encoded) {
          const m = dec.feed(b);
          if (m) msg = m;
        }
        if (!msg) msg = dec.finish();
        check("decoder produced a message", msg !== null);
        if (msg) {
          check("message type = CM/JM", msg.type === "CM/JM");
          const parsedModes = decodeModes(msg.octets);
          check("decoded v32bis = true", parsedModes.v32bis === true);
          check("decoded v22bis = true", parsedModes.v22bis === true);
          check("decoded v21 = true", parsedModes.v21 === true);
          check("decoded v34 = false (not advertised)", parsedModes.v34 === false);
          check("decoded callFn = 6 (b5=0 b6=1 b7=1 for Data)", parsedModes.callFn === 6);
        }
        console.log("\nTest 6: protocol selection from CM modes");
        const remoteModes = { v32bis: true, v22bis: true, v21: true };
        const preference = ["V34", "V32bis", "V22bis", "V22", "V21"];
        const chosen = selectProtocol(remoteModes, preference);
        check(
          "V.32bis selected when both sides support V.32bis + V.22bis + V.21",
          chosen === "V32bis",
          "got " + chosen
        );
        const remote2 = { v22bis: true, v21: true };
        check(
          "V.22bis selected when no V.32bis",
          selectProtocol(remote2, preference) === "V22bis"
        );
        console.log("\nTest 7: byte-level CI builder");
        const ciBytes = buildCIBytes();
        check("CI byte length = 2", ciBytes.length === 2);
        check("CI byte[0] = 0x00 (sync)", ciBytes[0] === 0);
        check("CI byte[1] = 0xC1 (call-fn Data)", ciBytes[1] === 193);
        console.log("\nTest 8: byte-level CM builder for V.32bis+V.22bis+V.21");
        const cmBytes = buildCMBytes({ v32bis: true, v22bis: true, v21: true });
        const cmExpected = [224, 193, 5, 19, 144];
        const cmOk = cmBytes.length === 5 && cmExpected.every((v, i) => cmBytes[i] === v);
        check(
          "CM bytes = [E0, C1, 05, 13, 90]",
          cmOk,
          "got " + Array.from(cmBytes).map((b) => b.toString(16).padStart(2, "0")).join(" ")
        );
        console.log("\nTest 9: byte-level CJ builder");
        const cjBytes = buildCJBytes();
        check(
          "CJ bytes = [00, 00, 00]",
          cjBytes.length === 3 && cjBytes[0] === 0 && cjBytes[1] === 0 && cjBytes[2] === 0
        );
        console.log("\nTest 10: parseV8Bytes round-trip on CI + CM + CJ sequence");
        const state = {};
        const stream = Buffer.concat([
          buildCIBytes(),
          buildCMBytes({ v32bis: true, v21: true }),
          buildCJBytes()
        ]);
        const msgs = parseV8Bytes(state, stream);
        check(
          "parsed 3 messages (CI + CM + CJ)",
          msgs.length === 3,
          "got " + msgs.length
        );
        if (msgs.length === 3) {
          check("msg[0].type === CI", msgs[0].type === "CI");
          check("msg[1].type === CM/JM", msgs[1].type === "CM/JM");
          check("msg[1].modes.v32bis === true", msgs[1].modes && msgs[1].modes.v32bis === true);
          check("msg[1].modes.v21 === true", msgs[1].modes && msgs[1].modes.v21 === true);
          check("msg[1].modes.v22bis === false", msgs[1].modes && msgs[1].modes.v22bis === false);
          check("msg[2].type === CJ", msgs[2].type === "CJ");
        }
        console.log("\nTest 11: parseV8Bytes handles byte-at-a-time streaming");
        const state2 = {};
        const allMsgs = [];
        for (const b of stream) {
          const got = parseV8Bytes(state2, Buffer.from([b]));
          for (const m of got) allMsgs.push(m);
        }
        check(
          "streaming produces same 3 messages",
          allMsgs.length === 3,
          "got " + allMsgs.length + " messages"
        );
        console.log("\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
        console.log(` SUMMARY: ${pass} pass, ${fail} fail`);
        console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
        process.exit(fail === 0 ? 0 : 1);
      }
    }
  });

  // vendor/src/dsp/protocols/FskCommon.js
  var require_FskCommon = __commonJS({
    "vendor/src/dsp/protocols/FskCommon.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var config = require_config();
      var { BiquadFilter, SinglePoleLPF, TWO_PI } = require_Primitives();
      var SR = config.rtp.sampleRate;
      var FskModulator = class {
        constructor({ markFreq, spaceFreq, baud, amplitude = 0.15 }) {
          this._markFreq = markFreq;
          this._spaceFreq = spaceFreq;
          this._baud = baud;
          this._amplitude = amplitude;
          this._curFreq = markFreq;
          this._phase = 0;
          this._bits = [];
          this._samplesPerSymbol = SR / baud;
          this._symbolPhase = 0;
          this._samplesLeft = 0;
        }
        /** Queue bytes to transmit (UART-framed: start + 8 data LSB-first + stop). */
        write(bytes) {
          for (const byte of bytes) {
            this._bits.push(0);
            for (let b = 0; b < 8; b++) this._bits.push(byte >> b & 1);
            this._bits.push(1);
          }
        }
        /** Queue raw bits (no UART framing). Used by V.8 preamble for V.21. */
        writeBits(bits) {
          for (const b of bits) this._bits.push(b & 1);
        }
        /** Generate numSamples of audio. Returns Float32Array. */
        generate(numSamples) {
          const out = new Float32Array(numSamples);
          let pos = 0;
          while (pos < numSamples) {
            if (this._samplesLeft <= 0) {
              const bit = this._bits.length > 0 ? this._bits.shift() : 1;
              this._curFreq = bit === 1 ? this._markFreq : this._spaceFreq;
              this._symbolPhase += this._samplesPerSymbol;
              this._samplesLeft = Math.floor(this._symbolPhase);
              this._symbolPhase -= this._samplesLeft;
            }
            const chunk = Math.min(this._samplesLeft, numSamples - pos);
            const phaseInc = TWO_PI * this._curFreq / SR;
            for (let i = 0; i < chunk; i++) {
              out[pos + i] = this._amplitude * Math.cos(this._phase);
              this._phase = (this._phase + phaseInc) % TWO_PI;
            }
            this._samplesLeft -= chunk;
            pos += chunk;
          }
          return out;
        }
        get idle() {
          return this._bits.length === 0;
        }
      };
      var FskDemodulator = class extends EventEmitter {
        constructor({ markFreq, spaceFreq, baud, q = 15 }) {
          super();
          this._markFreq = markFreq;
          this._spaceFreq = spaceFreq;
          this._baud = baud;
          this._bpMark = BiquadFilter.makeBandPass(markFreq, q, SR);
          this._bpSpace = BiquadFilter.makeBandPass(spaceFreq, q, SR);
          const fastAlpha = 1 - Math.exp(-TWO_PI * (baud * 0.8) / SR);
          this._envMark = new SinglePoleLPF(fastAlpha);
          this._envSpace = new SinglePoleLPF(fastAlpha);
          const slowAlpha = 1 - Math.exp(-TWO_PI * (baud / 2) / SR);
          this._slowEnvMark = new SinglePoleLPF(slowAlpha);
          this._slowEnvSpace = new SinglePoleLPF(slowAlpha);
          this._samplesPerSym = SR / baud;
          this._cdOnHyst = 8e-3;
          this._cdOffHyst = 3e-3;
          this._cd = false;
          this._cdHoldSamples = 0;
          this._cdHoldMax = Math.round(SR * 0.01);
          this._cdWarmupMax = Math.round(SR * 0.012);
          this._cdWarmup = 0;
          this._stableCount = 0;
          this._stableNeeded = 4;
          this._bitTimer = 0;
          this._bitPhase = 0;
          this._state = "IDLE";
          this._dataBits = new Array(8).fill(0);
          this._bitCount = 0;
          this._voteCount = 0;
          this._voteOnes = 0;
        }
        /** Schedule the next bit-sampling point at the canonical mid-bit. We
         *  collect three (mark>space) votes at timer = 1, 0, -1 (one sample
         *  before, at, and one sample after center) and majority-vote them.
         *  Centering on the original target keeps clean-signal behavior
         *  identical to single-sample decoding (all three votes agree). */
        _scheduleNextBit(initialOffset) {
          if (initialOffset != null) {
            this._bitPhase += this._samplesPerSym / 2 + this._samplesPerSym - initialOffset;
          } else {
            this._bitPhase += this._samplesPerSym;
          }
          this._bitTimer = Math.floor(this._bitPhase);
          this._bitPhase -= this._bitTimer;
          this._voteCount = 0;
          this._voteOnes = 0;
        }
        process(samples) {
          for (let i = 0; i < samples.length; i++) {
            const x = samples[i];
            const mEnv = this._envMark.process(Math.abs(this._bpMark.process(x)));
            const sEnv = this._envSpace.process(Math.abs(this._bpSpace.process(x)));
            const smEnv = this._slowEnvMark.process(mEnv);
            const ssEnv = this._slowEnvSpace.process(sEnv);
            const topEnv = Math.max(smEnv, ssEnv);
            if (!this._cd && topEnv > this._cdOnHyst) {
              this._cd = true;
              this._cdHoldSamples = this._cdHoldMax;
              this._cdWarmup = this._cdWarmupMax;
              this._state = "IDLE";
              this._stableCount = 0;
              this._bitCount = 0;
            } else if (this._cd && topEnv < this._cdOffHyst) {
              if (this._cdHoldSamples > 0) {
                this._cdHoldSamples--;
              } else {
                this._cd = false;
                this._cdWarmup = 0;
                this._state = "IDLE";
                this._stableCount = 0;
                this._bitCount = 0;
              }
            } else if (this._cd) {
              if (topEnv >= this._cdOffHyst) this._cdHoldSamples = this._cdHoldMax;
            }
            if (!this._cd) continue;
            if (this._cdWarmup > 0) {
              this._cdWarmup--;
              continue;
            }
            const bit = mEnv > sEnv ? 1 : 0;
            if (this._state === "IDLE") {
              if (bit === 0) {
                this._stableCount++;
                if (this._stableCount >= this._stableNeeded) {
                  this._state = "DATA";
                  this._bitCount = 0;
                  this._bitPhase = 0;
                  this._scheduleNextBit(this._stableNeeded);
                  this._stableCount = 0;
                }
              } else {
                this._stableCount = 0;
              }
              continue;
            }
            this._bitTimer--;
            if (this._bitTimer <= 1 && this._bitTimer >= -1 && this._voteCount < 3) {
              this._voteOnes += bit;
              this._voteCount++;
            }
            if (this._bitTimer <= -1) {
              const decided = this._voteOnes >= 2 ? 1 : 0;
              if (this._state === "DATA") {
                this._dataBits[this._bitCount] = decided;
                this.emit("bit", decided);
                if (++this._bitCount === 8) this._state = "STOP";
                this._scheduleNextBit();
              } else {
                if (decided === 1) {
                  let byte = 0;
                  for (let b = 0; b < 8; b++) byte |= this._dataBits[b] << b;
                  this.emit("data", Buffer.from([byte]));
                }
                this._state = "IDLE";
                this._stableCount = 0;
                this._bitCount = 0;
              }
            }
          }
        }
        get carrierDetected() {
          return this._cd;
        }
        reset() {
          this._bpMark.reset();
          this._bpSpace.reset();
          this._envMark.reset();
          this._envSpace.reset();
          this._slowEnvMark.reset();
          this._slowEnvSpace.reset();
          this._cd = false;
          this._cdHoldSamples = 0;
          this._cdWarmup = 0;
          this._stableCount = 0;
          this._bitTimer = 0;
          this._bitPhase = 0;
          this._state = "IDLE";
          this._bitCount = 0;
          this._voteCount = 0;
          this._voteOnes = 0;
        }
      };
      var CoherentFskDemodulator = class extends EventEmitter {
        constructor({ markFreq, spaceFreq, baud, cutoffDbm0 = -30 }) {
          super();
          this._markFreq = markFreq;
          this._spaceFreq = spaceFreq;
          this._baud = baud;
          this._phaseMark = 0;
          this._phaseSpace = 0;
          this._phaseIncMark = TWO_PI * markFreq / SR;
          this._phaseIncSpace = TWO_PI * spaceFreq / SR;
          this._winLen = Math.max(2, Math.floor(SR / baud));
          this._winRe = [new Float64Array(this._winLen), new Float64Array(this._winLen)];
          this._winIm = [new Float64Array(this._winLen), new Float64Array(this._winLen)];
          this._dotRe = [0, 0];
          this._dotIm = [0, 0];
          this._winPtr = 0;
          this._baudInc = baud;
          this._sixtyThresh = Math.floor(SR * 0.6);
          this._spsThresh = SR;
          this._startBitSeed = Math.floor(SR * 0.3);
          const refPower = 0.125;
          const dcBlockerCorrection = -5.3;
          const onDbm0 = cutoffDbm0 + 2.5 + dcBlockerCorrection;
          const offDbm0 = cutoffDbm0 - 2.5 + dcBlockerCorrection;
          this._carrierOnPower = refPower * Math.pow(10, onDbm0 / 10);
          this._carrierOffPower = refPower * Math.pow(10, offDbm0 / 10);
          this._powerAlpha = 1 - Math.exp(-1 / (this._winLen * 4));
          this._powerEst = 0;
          this._lastSample = 0;
          this._signalPresent = 0;
          this._baudPhase = 0;
          this._framePos = -2;
          this._frameInProg = 0;
          this._lastBit = -1;
          this._preRoll = 0;
        }
        /** Reset all per-call state. */
        reset() {
          this._phaseMark = 0;
          this._phaseSpace = 0;
          for (let j = 0; j < 2; j++) {
            this._winRe[j].fill(0);
            this._winIm[j].fill(0);
            this._dotRe[j] = 0;
            this._dotIm[j] = 0;
          }
          this._winPtr = 0;
          this._powerEst = 0;
          this._lastSample = 0;
          this._signalPresent = 0;
          this._baudPhase = 0;
          this._framePos = -2;
          this._frameInProg = 0;
          this._lastBit = -1;
          this._preRoll = 0;
        }
        /** True if carrier is currently detected. */
        get carrierDetected() {
          return this._signalPresent > 0;
        }
        process(samples) {
          const winLen = this._winLen;
          let winPtr = this._winPtr;
          for (let i = 0; i < samples.length; i++) {
            const x = samples[i];
            for (let j = 0; j < 2; j++) {
              this._dotRe[j] -= this._winRe[j][winPtr];
              this._dotIm[j] -= this._winIm[j][winPtr];
              const phase = j === 0 ? this._phaseMark : this._phaseSpace;
              const cs = Math.cos(phase);
              const sn = Math.sin(phase);
              const re = cs * x;
              const im = sn * x;
              this._winRe[j][winPtr] = re;
              this._winIm[j][winPtr] = im;
              this._dotRe[j] += re;
              this._dotIm[j] += im;
            }
            this._phaseMark += this._phaseIncMark;
            this._phaseSpace += this._phaseIncSpace;
            if (this._phaseMark >= TWO_PI) this._phaseMark -= TWO_PI;
            if (this._phaseSpace >= TWO_PI) this._phaseSpace -= TWO_PI;
            const dc = x - this._lastSample;
            this._lastSample = x;
            this._powerEst += this._powerAlpha * (dc * dc - this._powerEst);
            if (this._signalPresent > 0) {
              if (this._powerEst < this._carrierOffPower) {
                if (--this._signalPresent <= 0) {
                  this._baudPhase = 0;
                  this._framePos = -2;
                  this._frameInProg = 0;
                  this._lastBit = -1;
                  if (++winPtr >= winLen) winPtr = 0;
                  continue;
                }
              } else {
                this._signalPresent = 1;
              }
            } else {
              if (this._powerEst < this._carrierOnPower) {
                this._preRoll = 0;
                if (++winPtr >= winLen) winPtr = 0;
                continue;
              }
              if (this._preRoll < winLen >> 1) {
                this._preRoll++;
                if (++winPtr >= winLen) winPtr = 0;
                continue;
              }
              this._signalPresent = 1;
              this._baudPhase = 0;
              this._framePos = -2;
              this._frameInProg = 0;
              this._lastBit = -1;
            }
            const sumMark = this._dotRe[0] * this._dotRe[0] + this._dotIm[0] * this._dotIm[0];
            const sumSpace = this._dotRe[1] * this._dotRe[1] + this._dotIm[1] * this._dotIm[1];
            const baudstate = sumMark > sumSpace ? 1 : 0;
            this._processFrameBit(baudstate);
            if (++winPtr >= winLen) winPtr = 0;
          }
          this._winPtr = winPtr;
        }
        /**
         * Per-sample UART character framer.
         *
         * Faithful port of spandsp fsk.c's FSK_FRAME_MODE_FRAMED case,
         * using integer baud-phase arithmetic for exactness.
         *
         *   Per-sample increment = baud (bps)
         *   60% threshold        = SR * 0.6
         *   100% threshold       = SR
         *
         * Sub-sample accuracy is preserved by subtracting (not zeroing)
         * the SR threshold at each bit boundary, carrying the fractional
         * remainder into the next bit. Over many bits the actual symbol
         * period is exactly SR/baud samples on average.
         */
        _processFrameBit(baudstate) {
          if (this._framePos === -2) {
            if (baudstate === 0) {
              this._baudPhase = this._startBitSeed;
              this._framePos = -1;
              this._frameInProg = 0;
              this._lastBit = -1;
            }
            return;
          }
          if (this._framePos === -1) {
            if (baudstate !== 0) {
              this._framePos = -2;
              return;
            }
            this._baudPhase += this._baudInc;
            if (this._baudPhase >= this._spsThresh) {
              this._framePos = 0;
              this._lastBit = -1;
              this._baudPhase -= this._spsThresh;
            }
            return;
          }
          this._baudPhase += this._baudInc;
          if (this._baudPhase >= this._sixtyThresh) {
            if (this._lastBit < 0) this._lastBit = baudstate;
            if (this._lastBit !== baudstate) {
              this._framePos = -2;
              return;
            }
            if (this._baudPhase >= this._spsThresh) {
              if (this._framePos > 7) {
                if (baudstate === 1) {
                  this.emit("data", Buffer.from([this._frameInProg & 255]));
                }
                this._framePos = -2;
                this._frameInProg = 0;
              } else {
                this._frameInProg |= (baudstate & 1) << this._framePos;
                this.emit("bit", baudstate);
                this._framePos++;
              }
              this._baudPhase -= this._spsThresh;
              this._lastBit = -1;
            }
          }
        }
      };
      module.exports = { FskModulator, FskDemodulator, CoherentFskDemodulator, SR };
    }
  });

  // vendor/src/dsp/protocols/V21.js
  var require_V21 = __commonJS({
    "vendor/src/dsp/protocols/V21.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var { FskModulator, FskDemodulator } = require_FskCommon();
      var V21_CH1_MARK = 980;
      var V21_CH1_SPACE = 1180;
      var V21_CH2_MARK = 1650;
      var V21_CH2_SPACE = 1850;
      var V21_BAUD = 300;
      var V21Modulator = class extends FskModulator {
        /** @param {1|2} channel — 1 for originate, 2 for answer */
        constructor(channel) {
          const isCh2 = channel === 2;
          super({
            markFreq: isCh2 ? V21_CH2_MARK : V21_CH1_MARK,
            spaceFreq: isCh2 ? V21_CH2_SPACE : V21_CH1_SPACE,
            baud: V21_BAUD
          });
        }
      };
      var V21Demodulator = class extends FskDemodulator {
        /** @param {1|2} channel — TX channel; we receive from the OTHER channel */
        constructor(channel) {
          const rxCh = channel === 2 ? 1 : 2;
          const isCh2 = rxCh === 2;
          super({
            markFreq: isCh2 ? V21_CH2_MARK : V21_CH1_MARK,
            spaceFreq: isCh2 ? V21_CH2_SPACE : V21_CH1_SPACE,
            baud: V21_BAUD
          });
        }
      };
      var V21 = class extends EventEmitter {
        constructor(role) {
          super();
          const txCh = role === "answer" ? 2 : 1;
          this.modulator = new V21Modulator(txCh);
          this.demodulator = new V21Demodulator(txCh);
          this.demodulator.on("data", (buf) => this.emit("data", buf));
          this.demodulator.on("bit", (bit) => this.emit("bit", bit));
        }
        /** Write data bytes to be transmitted (UART-framed). */
        write(data) {
          this.modulator.write(data);
        }
        /** Write raw bits (no UART framing). For V.8 preamble. */
        writeBits(bits) {
          this.modulator.writeBits(bits);
        }
        /** Generate n samples of transmit audio. */
        generateAudio(n) {
          return this.modulator.generate(n);
        }
        /** Process received audio samples. */
        receiveAudio(samples) {
          this.demodulator.process(samples);
        }
        /** True if RX carrier is currently detected. */
        get carrierDetected() {
          return this.demodulator.carrierDetected;
        }
        get name() {
          return "V21";
        }
        get bps() {
          return V21_BAUD;
        }
      };
      module.exports = { V21, V21Modulator, V21Demodulator };
    }
  });

  // vendor/src/dsp/V8Sequencer.js
  var require_V8Sequencer = __commonJS({
    "vendor/src/dsp/V8Sequencer.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var { makeLogger } = require_logger();
      var log = makeLogger("V8Sequencer");
      var cfg = require_config().modem.native;
      var SR = require_config().rtp.sampleRate;
      var V8 = require_V8();
      var { FskModulator } = require_FskCommon();
      var { V21Demodulator } = require_V21();
      var { goertzel } = require_Primitives();
      var ST = {
        WAIT_1S: "WAIT_1S",
        // originate: wait 1s before first CI
        CI_ON: "CI_ON",
        // originate: transmitting CI
        CI_OFF: "CI_OFF",
        // originate: silence between CI bursts
        HEARD_ANSAM: "HEARD_ANSAM",
        // originate: ANSam detected, Te wait
        CM_ON: "CM_ON",
        // originate: transmitting CM, listening for JM
        CJ_ON: "CJ_ON",
        // originate: transmitting CJ
        SIGC: "SIGC",
        // originate: 75ms silence post-CJ
        CM_WAIT: "CM_WAIT",
        // answer: ANSam + listening for CM
        JM_ON: "JM_ON",
        // answer: transmitting JM, listening for CJ
        SIGA: "SIGA",
        // answer: 75ms silence post-CJ
        PARKED: "PARKED"
        // terminal: result handler called
      };
      var WAIT_1S_MS = 1e3;
      var CI_OFF_MS = 500;
      var TE_MS = 1e3;
      var POST_SIG_MS = 75;
      var MAX_CI_COUNT = 10;
      var CM_WAIT_TIMEOUT_MS = 5e3;
      var JM_WAIT_TIMEOUT_MS = 5e3;
      var TWO_PI = 2 * Math.PI;
      var ANS_FREQ = 2100;
      var ANSAM_AM_FREQ = 15;
      var ANSAM_REVERSAL_MS = 450;
      var AnsamGenerator = class {
        constructor({ amplitude = 0.15, withPhaseReversals = true } = {}) {
          this._avgAmp = amplitude / 1.2;
          this._carrierPhase = 0;
          this._amPhase = 0;
          this._carrierInc = TWO_PI * ANS_FREQ / SR;
          this._amInc = TWO_PI * ANSAM_AM_FREQ / SR;
          this._withPR = withPhaseReversals;
          this._samplesPerReversal = Math.round(ANSAM_REVERSAL_MS * SR / 1e3);
          this._samplesUntilReversal = this._samplesPerReversal;
        }
        /** Produce numSamples of ANSam audio, advancing internal state. */
        generate(numSamples) {
          const out = new Float32Array(numSamples);
          for (let i = 0; i < numSamples; i++) {
            const env = this._avgAmp * (1 + 0.2 * Math.sin(this._amPhase));
            out[i] = env * Math.cos(this._carrierPhase);
            this._carrierPhase = (this._carrierPhase + this._carrierInc) % TWO_PI;
            this._amPhase = (this._amPhase + this._amInc) % TWO_PI;
            if (this._withPR && --this._samplesUntilReversal <= 0) {
              this._carrierPhase = (this._carrierPhase + Math.PI) % TWO_PI;
              this._samplesUntilReversal = this._samplesPerReversal;
            }
          }
          return out;
        }
      };
      var V8Sequencer = class extends EventEmitter {
        /**
         * @param {Object} opts
         * @param {'answer'|'originate'} opts.role
         * @param {Object} opts.parms       — capability advertisement
         * @param {string[]} opts.parms.modulations  — keys of V.8 modes object
         *                                             (e.g. ['v22bis','v23','v21'])
         * @param {number}  opts.parms.callFn   — V.8 §6.1 call function code
         *                                        (default 6 = V-series modem data)
         */
        constructor({ role, parms }) {
          super();
          this._role = role;
          this._parms = parms || {};
          this._parms.callFn = this._parms.callFn != null ? this._parms.callFn : 6;
          this._parms.modulations = this._parms.modulations || ["V22bis", "V22", "V23", "V21"];
          this._tag = role === "answer" ? "[A]" : "[O]";
          this._state = ST.PARKED;
          this._stateTimer = 0;
          this._negTimer = 0;
          this._ciCount = 0;
          this._v21tx = null;
          this._v21rx = null;
          this._ansam = null;
          this._ansamSamplesLeft = 0;
          this._ansamPostSilenceSamplesLeft = 0;
          this._fskTxOn = false;
          this._lastCmBytes = null;
          this._gotCmJm = false;
          this._receivedFar = null;
          this._zeroByteCount = 0;
          this._gotCj = false;
          this._parser = {};
          this._result = null;
          this._onV21Data = null;
        }
        // ─── Public API ───────────────────────────────────────────────────────────
        start() {
          if (this._role === "answer") {
            this._startAnswer();
          } else {
            this._startOriginate();
          }
        }
        /**
         * Generate up to numSamples of TX audio. Returns Float32Array of exactly
         * that length. Mirrors v8.c's v8_tx().
         */
        generateAudio(n) {
          const out = new Float32Array(n);
          let pos = 0;
          if (this._ansam && this._ansamSamplesLeft > 0) {
            const take = Math.min(this._ansamSamplesLeft, n - pos);
            const block = this._ansam.generate(take);
            out.set(block, pos);
            pos += take;
            this._ansamSamplesLeft -= take;
          }
          if (this._ansamPostSilenceSamplesLeft > 0 && pos < n) {
            const take = Math.min(this._ansamPostSilenceSamplesLeft, n - pos);
            pos += take;
            this._ansamPostSilenceSamplesLeft -= take;
          }
          if (this._fskTxOn && this._v21tx && pos < n) {
            const before = this._v21tx._bits.length;
            const block = this._v21tx.generate(n - pos);
            out.set(block, pos);
            const after = this._v21tx._bits.length;
            if (this._state === ST.CJ_ON || this._state === ST.SIGC) {
              log.trace(`${this._tag} gen ${n - pos} samples bits ${before}\u2192${after} state=${this._state}`);
            }
            pos = n;
          }
          return out;
        }
        /**
         * Process a block of received audio. Mirrors v8.c's v8_rx().
         * Drives the state machine forward by `samples.length` samples per call.
         */
        receiveAudio(samples) {
          const len = samples.length;
          if (this._v21rx && this._isRxActive()) {
            this._v21rx.process(samples);
          }
          if (this._negTimer > 0) {
            this._negTimer -= len;
            if (this._negTimer <= 0) {
              this._handleTimeout();
              return;
            }
          }
          if (this._state === ST.JM_ON || this._state === ST.CM_ON) {
            this._refillTxQueue();
          }
          if (this._state === ST.SIGA || this._state === ST.SIGC) {
            this._stateTimer -= len;
            if (this._stateTimer <= 0) {
              this._fskTxOn = false;
              this._setState(ST.PARKED);
              this.emit("result", this._result);
              return;
            }
          }
          if (this._state === ST.HEARD_ANSAM) {
            this._stateTimer -= len;
            if (this._stateTimer <= 0) {
              this._originateStartCm();
            }
          }
          if (this._state === ST.CJ_ON) {
            if (this._v21tx && this._v21tx._bits.length === 0) {
              log.debug(`${this._tag} CJ TX queue drained \u2192 entering 75 ms post-CJ silence`);
              this._fskTxOn = false;
              this._stateTimer = Math.round(POST_SIG_MS * SR / 1e3);
              this._setState(ST.SIGC);
            }
          }
          if (this._role === "originate" && (this._state === ST.CI_ON || this._state === ST.CI_OFF || this._state === ST.WAIT_1S)) {
            this._driveOriginateCi(samples);
          }
        }
        stop() {
          this._setState(ST.PARKED);
          if (this._v21rx && this._onV21Data) {
            this._v21rx.removeListener && this._v21rx.removeListener("data", this._onV21Data);
          }
          this._v21rx = null;
          this._v21tx = null;
          this._ansam = null;
        }
        // ─── Answer-side state machine ────────────────────────────────────────────
        _startAnswer() {
          log.debug(`${this._tag} Starting V.8 answer sequencer`);
          this._initV21Rx("answer");
          this._ansam = new AnsamGenerator({ amplitude: 0.15, withPhaseReversals: true });
          this._ansamSamplesLeft = Math.round(cfg.answerToneDurationMs * SR / 1e3);
          this._fskTxOn = false;
          this._negTimer = Math.round(CM_WAIT_TIMEOUT_MS * SR / 1e3);
          this._setState(ST.CM_WAIT);
        }
        _onCmReceived(msg) {
          if (!msg.bytes) {
            log.warn(`${this._tag} CM message has no raw byte payload \u2014 skipping (parser bug)`);
            return;
          }
          if (this._lastCmBytes && Buffer.compare(this._lastCmBytes, msg.bytes) === 0) {
            this._gotCmJm = true;
            this._receivedFar = msg.modes;
            log.info(`${this._tag} V.8 CM accepted: modes=${this._summarize(msg.modes)} callFn=${msg.callFn}`);
            this._answerStartJm();
          } else {
            this._lastCmBytes = Buffer.from(msg.bytes);
            log.debug(`${this._tag} V.8 CM #1 captured (${msg.bytes.length} bytes), awaiting confirm`);
          }
        }
        _answerStartJm() {
          const localModes = this._buildLocalModes();
          const jmModes = {};
          const modeKeys = [
            "v34",
            "v34hd",
            "v32bis",
            "v22bis",
            "v17",
            "v29hd",
            "v27ter",
            "v26ter",
            "v26bis",
            "v23",
            "v23hd",
            "v21",
            "pcm"
          ];
          for (const k of modeKeys) {
            jmModes[k] = !!(this._receivedFar[k] && localModes[k]);
          }
          const anyMode = modeKeys.some((k) => jmModes[k]);
          if (!anyMode) {
            log.warn(`${this._tag} V.8 JM intersection empty \u2014 sending no-deal JM`);
          } else {
            log.info(`${this._tag} V.8 JM: sending ${this._summarize(jmModes)}`);
          }
          this._jmBytes = V8.buildJMBytes(jmModes);
          this._negotiatedModes = jmModes;
          this._initV21Tx("answer");
          this._writeV8Frame(this._jmBytes);
          this._negTimer = Math.round(JM_WAIT_TIMEOUT_MS * SR / 1e3);
          this._ansamSamplesLeft = 0;
          this._ansamPostSilenceSamplesLeft = Math.round(POST_SIG_MS * SR / 1e3);
          this._fskTxOn = true;
          this._setState(ST.JM_ON);
        }
        _onCjReceived() {
          if (this._state !== ST.JM_ON) return;
          log.info(`${this._tag} V.8 CJ detected \u2014 flushing JM, entering 75 ms post-CJ silence`);
          this._v21tx._bits = [];
          this._fskTxOn = false;
          this._stateTimer = Math.round(POST_SIG_MS * SR / 1e3);
          this._setState(ST.SIGA);
          this._result = {
            role: "answer",
            modes: this._negotiatedModes,
            callFn: this._parms.callFn,
            protocol: this._selectProtocol(this._negotiatedModes)
          };
        }
        // ─── Originate-side state machine ─────────────────────────────────────────
        _startOriginate() {
          log.debug(`${this._tag} Starting V.8 originate sequencer`);
          this._initV21Rx("originate");
          this._stateTimer = Math.round(WAIT_1S_MS * SR / 1e3);
          this._setState(ST.WAIT_1S);
          this._initV21Tx("originate");
          this._negTimer = Math.round(CM_WAIT_TIMEOUT_MS * SR / 1e3);
        }
        _driveOriginateCi(samples) {
          const len = samples.length;
          const ansPower = goertzel(samples, ANS_FREQ, SR);
          if (ansPower > 0.03) {
            this._ansDetectCount = (this._ansDetectCount || 0) + 1;
            if (this._ansDetectCount >= 3) {
              log.info(`${this._tag} V.8: ANSam detected, Te silence then CM`);
              this._fskTxOn = false;
              this._v21tx._bits = [];
              this._stateTimer = Math.round(TE_MS * SR / 1e3);
              this._setState(ST.HEARD_ANSAM);
              return;
            }
          } else {
            this._ansDetectCount = 0;
          }
          if (this._stateTimer > 0) {
            this._stateTimer -= len;
            if (this._stateTimer > 0) return;
          }
          if (this._state === ST.WAIT_1S) {
            this._sendCiBurst();
            return;
          }
          if (this._state === ST.CI_ON) {
            if (this._v21tx._bits.length === 0) {
              this._fskTxOn = false;
              this._stateTimer = Math.round(CI_OFF_MS * SR / 1e3);
              this._setState(ST.CI_OFF);
            }
            return;
          }
          if (this._state === ST.CI_OFF) {
            this._ciCount++;
            if (this._ciCount >= MAX_CI_COUNT) {
              log.warn(`${this._tag} V.8: gave up after ${this._ciCount} CI bursts (no ANSam)`);
              this._setState(ST.PARKED);
              this.emit("failed", "timeout-no-ansam");
              return;
            }
            this._sendCiBurst();
            return;
          }
        }
        _sendCiBurst() {
          const ci = V8.buildCIBytes();
          this._writeV8Frame(Buffer.concat([ci, ci, ci, ci]));
          this._fskTxOn = true;
          this._stateTimer = 0;
          this._setState(ST.CI_ON);
        }
        _originateStartCm() {
          this._initV21Tx("originate");
          const localModes = this._buildLocalModes();
          log.info(`${this._tag} V.8 CM: sending ${this._summarize(localModes)}`);
          this._cmBytes = V8.buildCMBytes(localModes);
          this._writeV8Frame(this._cmBytes);
          this._fskTxOn = true;
          this._negTimer = Math.round(CM_WAIT_TIMEOUT_MS * SR / 1e3);
          this._setState(ST.CM_ON);
        }
        // _onJmReceived handles incoming JM from the answer side (originate role).
        _onJmReceived(msg) {
          if (this._state !== ST.CM_ON) return;
          if (!msg.bytes) return;
          if (this._lastCmBytes && Buffer.compare(this._lastCmBytes, msg.bytes) === 0) {
            this._gotCmJm = true;
            this._receivedFar = msg.modes;
            log.info(`${this._tag} V.8 JM accepted: modes=${this._summarize(msg.modes)}`);
            this._originateStartCj();
          } else {
            this._lastCmBytes = Buffer.from(msg.bytes);
          }
        }
        _originateStartCj() {
          const protocol = this._selectProtocol(this._receivedFar);
          if (!protocol) {
            log.warn(`${this._tag} V.8: empty JM intersection, no deal`);
            this._setState(ST.PARKED);
            this.emit("failed", "no-deal");
            return;
          }
          this._initV21Tx("originate");
          this._v21tx.writeBits(new Array(10).fill(1));
          const cj = V8.buildCJBytes();
          this._v21tx.write(cj);
          this._fskTxOn = true;
          this._result = {
            role: "originate",
            modes: this._receivedFar,
            callFn: this._parms.callFn,
            protocol
          };
          this._setState(ST.CJ_ON);
          this._stateTimer = 0;
        }
        // ─── Helpers ──────────────────────────────────────────────────────────────
        _setState(s) {
          if (s !== this._state) {
            log.debug(`${this._tag} state ${this._state} \u2192 ${s}`);
            this._state = s;
          }
        }
        _isRxActive() {
          if (this._role === "answer") {
            return this._state === ST.CM_WAIT || this._state === ST.JM_ON;
          }
          return this._state === ST.CM_ON || this._state === ST.CJ_ON;
        }
        _initV21Rx(role) {
          this._v21rx = new V21Demodulator(role === "answer" ? 2 : 1);
          this._onV21Data = (buf) => {
            log.trace(`${this._tag} V.21 RX bytes: ` + buf.toString("hex") + " (state=" + this._state + ")");
            const msgs = V8.parseV8Bytes(this._parser, buf);
            for (const m of msgs) this._handleParsedMsg(m);
          };
          this._v21rx.on("data", this._onV21Data);
        }
        _initV21Tx(role) {
          const { V21Modulator } = require_V21();
          this._v21tx = new V21Modulator(role === "answer" ? 2 : 1);
        }
        _writeV8Frame(bytes) {
          if (!this._v21tx) return;
          const preamble = new Array(10).fill(1);
          if (typeof this._v21tx.writeBits === "function") {
            this._v21tx.writeBits(preamble);
          }
          this._v21tx.write(bytes);
        }
        _refillTxQueue() {
          if (!this._v21tx) return;
          if (this._role === "answer" && this._state === ST.JM_ON) {
            if (this._v21tx._bits.length < 10 && this._jmBytes) {
              this._writeV8Frame(this._jmBytes);
            }
          } else if (this._role === "originate" && this._state === ST.CM_ON) {
            if (this._v21tx._bits.length < 10 && this._cmBytes) {
              this._writeV8Frame(this._cmBytes);
            }
          }
        }
        _handleParsedMsg(msg) {
          log.debug(`${this._tag} V.8 RX: ${msg.type}` + (msg.modes ? " modes=" + this._summarize(msg.modes) : "") + (msg.callFn !== void 0 ? " callFn=" + msg.callFn : ""));
          if (this._role === "answer") {
            if (msg.type === "CM/JM" && this._state === ST.CM_WAIT) {
              this._onCmReceived(msg);
            } else if (msg.type === "CJ" && this._state === ST.JM_ON) {
              this._onCjReceived();
            }
          } else {
            if (msg.type === "CM/JM" && this._state === ST.CM_ON) {
              this._onJmReceived(msg);
            }
          }
        }
        _handleTimeout() {
          if (this._state === ST.PARKED) return;
          if (this._role === "answer" && this._state === ST.CM_WAIT) {
            log.warn(`${this._tag} V.8: timeout waiting for CM`);
            this._setState(ST.PARKED);
            this.emit("failed", "timeout-no-cm");
          } else if (this._role === "answer" && this._state === ST.JM_ON) {
            log.warn(`${this._tag} V.8: timeout waiting for CJ`);
            this._setState(ST.PARKED);
            this.emit("failed", "timeout-no-cj");
          } else if (this._role === "originate" && this._state === ST.CM_ON) {
            log.warn(`${this._tag} V.8: timeout waiting for JM`);
            this._setState(ST.PARKED);
            this.emit("failed", "timeout-no-jm");
          }
        }
        _buildLocalModes() {
          const advertised = this._parms.modulations;
          return {
            v34: advertised.includes("V34"),
            v34hd: false,
            v32bis: advertised.includes("V32bis"),
            v22bis: advertised.includes("V22bis") || advertised.includes("V22"),
            v17: advertised.includes("V17"),
            v29hd: false,
            v27ter: false,
            v26ter: false,
            v26bis: false,
            v23: advertised.includes("V23"),
            v23hd: false,
            v21: advertised.includes("V21"),
            pcm: false
          };
        }
        _selectProtocol(modes) {
          if (!modes) return null;
          const preference = cfg.protocolPreference || ["V22bis", "V22", "V23", "V21"];
          return V8.selectProtocol(modes, preference);
        }
        _summarize(modes) {
          if (!modes) return "{}";
          return "{" + Object.keys(modes).filter((k) => modes[k] === true).join(",") + "}";
        }
      };
      module.exports = { V8Sequencer, ST, AnsamGenerator };
    }
  });

  // vendor/src/dsp/protocols/Bell103.js
  var require_Bell103 = __commonJS({
    "vendor/src/dsp/protocols/Bell103.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var { FskModulator, FskDemodulator } = require_FskCommon();
      var B103_CH1_MARK = 1270;
      var B103_CH1_SPACE = 1070;
      var B103_CH2_MARK = 2225;
      var B103_CH2_SPACE = 2025;
      var B103_BAUD = 300;
      var Bell103Modulator = class extends FskModulator {
        /** @param {1|2} channel — 1 for originate, 2 for answer */
        constructor(channel) {
          const isCh2 = channel === 2;
          super({
            markFreq: isCh2 ? B103_CH2_MARK : B103_CH1_MARK,
            spaceFreq: isCh2 ? B103_CH2_SPACE : B103_CH1_SPACE,
            baud: B103_BAUD
          });
        }
      };
      var Bell103Demodulator = class extends FskDemodulator {
        /** @param {1|2} channel — TX channel; we receive from the OTHER channel */
        constructor(channel) {
          const rxCh = channel === 2 ? 1 : 2;
          const isCh2 = rxCh === 2;
          super({
            markFreq: isCh2 ? B103_CH2_MARK : B103_CH1_MARK,
            spaceFreq: isCh2 ? B103_CH2_SPACE : B103_CH1_SPACE,
            baud: B103_BAUD
          });
        }
      };
      var Bell103 = class extends EventEmitter {
        constructor(role) {
          super();
          const txCh = role === "answer" ? 2 : 1;
          this.modulator = new Bell103Modulator(txCh);
          this.demodulator = new Bell103Demodulator(txCh);
          this.demodulator.on("data", (buf) => this.emit("data", buf));
          this.demodulator.on("bit", (bit) => this.emit("bit", bit));
        }
        /** Write data bytes to be transmitted (UART-framed). */
        write(data) {
          this.modulator.write(data);
        }
        /** Write raw bits (no UART framing). */
        writeBits(bits) {
          this.modulator.writeBits(bits);
        }
        /** Generate n samples of transmit audio. */
        generateAudio(n) {
          return this.modulator.generate(n);
        }
        /** Process received audio samples. */
        receiveAudio(samples) {
          this.demodulator.process(samples);
        }
        /** True if RX carrier is currently detected. */
        get carrierDetected() {
          return this.demodulator.carrierDetected;
        }
        get name() {
          return "Bell103";
        }
        get bps() {
          return B103_BAUD;
        }
      };
      module.exports = { Bell103, Bell103Modulator, Bell103Demodulator };
    }
  });

  // vendor/src/dsp/protocols/V22Common.js
  var require_V22Common = __commonJS({
    "vendor/src/dsp/protocols/V22Common.js"(exports, module) {
      "use strict";
      var SR = 8e3;
      var BAUD = 600;
      var SPS = SR / BAUD;
      var CARRIER_LOW = 1200;
      var CARRIER_HIGH = 2400;
      var GUARD_FREQ = 1800;
      var PHASE_CHANGE = [
        Math.PI / 2,
        // 00 → +90°
        0,
        // 01 →   0°
        Math.PI,
        // 10 → +180°
        3 * Math.PI / 2
        // 11 → +270°
      ];
      var QUADRANT_POINT = [
        { i: 1, q: 1 },
        // 00 → inner
        { i: 3, q: 1 },
        // 01 → V.22 compatible
        { i: 1, q: 3 },
        // 10 → middle-outer
        { i: 3, q: 3 }
        // 11 → outer
      ];
      var RRC_BETA = 0.75;
      var RRC_SPAN = 6;
      function rrcImpulse(t, beta) {
        const EPS = 1e-8;
        if (Math.abs(t) < EPS) {
          return 1 + beta * (4 / Math.PI - 1);
        }
        const tCrit = 1 / (4 * beta);
        if (Math.abs(Math.abs(t) - tCrit) < EPS) {
          return beta / Math.sqrt(2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * beta)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * beta)));
        }
        const pit = Math.PI * t;
        const num = Math.sin(pit * (1 - beta)) + 4 * beta * t * Math.cos(pit * (1 + beta));
        const den = pit * (1 - 4 * beta * t * (4 * beta * t));
        return num / den;
      }
      function buildRrcTaps(beta = RRC_BETA, span = RRC_SPAN) {
        const totalSamples = Math.round(span * SPS);
        const centerSample = totalSamples / 2;
        const taps = new Float32Array(totalSamples);
        let peak = 0;
        for (let n = 0; n < totalSamples; n++) {
          const t = (n - centerSample) / SPS;
          taps[n] = rrcImpulse(t, beta);
          if (Math.abs(taps[n]) > peak) peak = Math.abs(taps[n]);
        }
        return { taps, span: totalSamples, centerOffset: centerSample, gain: peak };
      }
      var RRC = buildRrcTaps(RRC_BETA, RRC_SPAN);
      var V22Scrambler = class {
        constructor() {
          this._reg = new Uint8Array(17);
          this._onesCount = 0;
          this._invertNext = false;
        }
        reset() {
          this._reg.fill(0);
          this._onesCount = 0;
          this._invertNext = false;
        }
        scramble(bitIn) {
          let di = bitIn & 1;
          if (this._invertNext) {
            di ^= 1;
            this._invertNext = false;
          }
          const ds = di ^ this._reg[13] ^ this._reg[16];
          for (let i = 16; i > 0; i--) this._reg[i] = this._reg[i - 1];
          this._reg[0] = ds;
          if (ds === 1) {
            this._onesCount++;
            if (this._onesCount >= 64) {
              this._invertNext = true;
              this._onesCount = 0;
            }
          } else {
            this._onesCount = 0;
          }
          return ds;
        }
        descramble(bitIn) {
          const ds = bitIn & 1;
          let dout = ds ^ this._reg[13] ^ this._reg[16];
          if (this._invertNext) {
            dout ^= 1;
            this._invertNext = false;
          }
          for (let i = 16; i > 0; i--) this._reg[i] = this._reg[i - 1];
          this._reg[0] = ds;
          if (ds === 1) {
            this._onesCount++;
            if (this._onesCount >= 64) {
              this._invertNext = true;
              this._onesCount = 0;
            }
          } else {
            this._onesCount = 0;
          }
          return dout;
        }
      };
      module.exports = {
        SR,
        BAUD,
        SPS,
        CARRIER_LOW,
        CARRIER_HIGH,
        GUARD_FREQ,
        PHASE_CHANGE,
        QUADRANT_POINT,
        RRC_BETA,
        RRC_SPAN,
        rrcImpulse,
        buildRrcTaps,
        RRC,
        V22Scrambler
      };
    }
  });

  // vendor/src/dsp/protocols/V22RxRRC.js
  var require_V22RxRRC = __commonJS({
    "vendor/src/dsp/protocols/V22RxRRC.js"(exports, module) {
      "use strict";
      var RX_PULSESHAPER_1200_RE = [
        [-0.0077199531, -0.0020117831, 0.0018930905, -0.0018886601, -0.0051777074, 0.0053673583, 0.0259041569, 0.0306906511, -0, -0.0480508285, -0.0654548563, -0.023650088, 0.0481953616, 0.0848257764, 0.0498593404, -0.0253378011, -0.0727874866, -0.0556792264, -0, 0.0395400094, 0.0360790241, 0.0084167708, -0.0102093222, -0.0088088419, -0.0011101265, -9952566e-10, -0.0061916317],
        [-0.0076484017, -0.0019477861, 1684209e-9, -0.0023974435, -0.0055622678, 0.0056077999, 0.0267290372, 0.0314277803, -0, -0.0487276079, -0.066136064, -0.0238192334, 0.0483954586, 0.0849352512, 0.0497833688, -0.025226926, -0.0722519797, -0.055090051, -0, 0.0388079455, 0.0352140991, 0.0081505533, -0.0097573632, -0.0081660725, -8185179e-10, -0.0011011405, -0.0063774162],
        [-0.0075672128, -0.0018801216, 0.0014678277, -0.0029188412, -0.0059534896, 0.0058509996, 0.0275591626, 0.0321659901, -0, -0.0493979284, -0.0668055385, -0.023983445, 0.0485846568, 0.0850248959, 0.049695811, -0.0251104277, -0.0717018016, -0.054491449, -0, 0.0380738551, 0.0343511453, 0.0078862345, -0.0093109298, -0.0075349297, -5343835e-10, -0.0012031064, -0.0065521383],
        [-0.0074762239, -0.0018087555, 0.0012439291, -0.0034527905, -0.0063512797, 0.0060968805, 0.0283942262, 0.0329049781, -0, -0.0500614817, -0.0674629611, -0.0241426429, 0.0487628628, 0.0850946657, 0.0495967106, -0.0249883635, -0.071137219, -0.0538837034, -0, 0.0373380555, 0.0334905086, 0.0076239091, -0.0088701557, -0.0069155483, -2577464e-10, -0.0013011702, -0.0067159185],
        [-0.0073752765, -0.0017336559, 0.0010125003, -0.0039992207, -0.0067555402, 0.0063453638, 0.0292339159, 0.03364444, -0, -0.0507179614, -0.0681080183, -0.0242967495, 0.0489299885, 0.0851445261, 0.0494861167, -0.0248607937, -0.0705585051, -0.0532671006, -0, 0.0366008627, 0.0326325308, 0.0073636698, -0.0084351699, -0.0063080551, 113752e-10, -0.0013953496, -6868883e-9],
        [-0.0072642164, -0.0016547927, 7735326e-10, -4558053e-9, -0.0071661687, 0.0065963684, 0.0300779148, 0.0343840691, -0, -0.0513670633, -0.0687404015, -0.0244456895, 0.0490859512, 0.0851744523, 0.0493640842, -0.0247277807, -0.0699659394, -0.0526419305, -0, 0.0358625918, 0.0317775504, 0.0071056075, -0.0080060972, -0.0057125689, 2729677e-10, -0.0014856648, -0.0070111627],
        [-0.0071428936, -0.0015721377, 5270217e-10, -0.0051292006, -0.0075830582, 0.0068498114, 0.0309259017, 0.0351235565, -0, -0.052008486, -0.0693598077, -0.0245893901, 0.0492306737, 0.0851844294, 0.0492306737, -0.0245893901, -0.0693598077, -0.052008486, -0, 0.0351235565, 0.0309259017, 0.0068498114, -0.0075830582, -0.0051292006, 5270217e-10, -0.0015721377, -0.0071428936],
        [-0.0070111627, -0.0014856648, 2729677e-10, -5712569e-9, -0.0080060972, 0.0071056075, 0.0317775504, 0.0358625918, -0, -0.0526419305, -0.0699659394, -0.0247277807, 0.0493640842, 0.0851744523, 0.0490859512, -0.0244456895, -0.0687404015, -0.0513670633, -0, 0.0343840691, 0.0300779148, 0.0065963684, -0.0071661686, -4558053e-9, 7735326e-10, -0.0016547927, -0.0072642164],
        [-6868883e-9, -0.0013953496, 113752e-10, -0.0063080551, -0.0084351699, 0.0073636698, 0.0326325308, 0.0366008627, -0, -0.0532671006, -0.0705585051, -0.0248607937, 0.0494861167, 0.0851445261, 0.0489299885, -0.0242967495, -0.0681080183, -0.0507179613, -0, 0.03364444, 0.0292339158, 0.0063453638, -0.0067555402, -0.0039992207, 0.0010125004, -0.0017336559, -0.0073752765],
        [-0.0067159185, -0.0013011702, -2577464e-10, -0.0069155483, -0.0088701557, 0.0076239091, 0.0334905086, 0.0373380555, -0, -0.0538837034, -0.071137219, -0.0249883635, 0.0495967106, 0.0850946657, 0.0487628628, -0.0241426429, -0.0674629611, -0.0500614817, -0, 0.0329049781, 0.0283942262, 0.0060968805, -0.0063512797, -0.0034527905, 0.0012439292, -0.0018087555, -0.0074762239],
        [-0.0065521382, -0.0012031064, -5343835e-10, -0.0075349297, -0.0093109298, 0.0078862345, 0.0343511453, 0.0380738552, -0, -0.054491449, -0.0717018016, -0.0251104277, 0.049695811, 0.0850248959, 0.0485846568, -0.023983445, -0.0668055384, -0.0493979284, -0, 0.0321659901, 0.0275591626, 0.0058509996, -0.0059534896, -0.0029188412, 0.0014678277, -0.0018801216, -0.0075672128],
        [-0.0063774162, -0.0011011405, -8185179e-10, -0.0081660725, -0.0097573632, 0.0081505533, 0.0352140991, 0.0388079455, -0, -0.055090051, -0.0722519797, -0.025226926, 0.0497833688, 0.0849352512, 0.0483954586, -0.0238192334, -0.0661360639, -0.0487276079, -0, 0.0314277803, 0.0267290372, 0.0056077999, -0.0055622677, -0.0023974435, 1684209e-9, -0.0019477861, -0.0076484017]
      ];
      var RX_PULSESHAPER_1200_IM = [
        [-0.0025083648, -0.0061916317, -0.0026056155, -0, -0.0071265028, -0.0165190304, -0.0084167708, 0.0222980632, 0.0488741394, 0.0349109704, -0.021267572, -0.0727874866, -0.0663352244, 0, 0.0686254947, 0.0779817332, 0.0236500881, -0.0404533259, -0.0593940904, -0.0287274984, 0.0117227856, 0.0259041569, 0.0140519265, 0, -0.0015279581, 0.0030630847, 0.0020117831],
        [-0.0024851164, -0.0059946693, -0.0023181148, -0, -0.0076558048, -0.0172590335, -0.0086847906, 0.022833619, 0.0497761225, 0.0354026794, -0.0214889098, -0.0733080624, -0.0666106342, 0, 0.0685209288, 0.0776404948, 0.0234760913, -0.0400252649, -0.0585499453, -0.0281956228, 0.0114417544, 0.0250848237, 0.0134298582, 0, -0.0011265932, 3388962e-9, 0.0020721481],
        [-0.0024587365, -0.0057864192, -0.0020202915, -0, -0.0081942754, -0.018007525, -0.0089545147, 0.0233699597, 0.0506748142, 0.0358896958, -0.0217064353, -0.0738134538, -0.0668710432, 0, 0.0684004158, 0.0772819499, 0.0232973276, -0.0395903551, -0.0576985862, -0.027662275, 0.0111613637, 0.0242713341, 0.0128153955, 0, -7355159e-10, 0.0037027809, 0.0021289188],
        [-0.0024291724, -0.0055667771, -0.0017121216, -0, -0.0087417865, -0.0187642687, -0.0092258433, 0.023906866, 0.0515698207, 0.0363717955, -0.0219200448, -0.0743034147, -0.0671163227, 0, 0.0682640158, 0.0769062751, 0.0231138836, -0.0391488021, -0.0568404006, -0.0271276853, 0.0108817259, 0.0234639794, 0.0122087219, 0, -3547575e-10, 0.0040045901, 0.0021821342],
        [-0.0023963726, -0.0053356444, -0.0013935872, -0, -0.0092982033, -0.0195290216, -0.0094986751, 0.0244441165, 0.0524607475, 0.0368487558, -0.0221296366, -0.0747777061, -0.0673463515, 0, 0.0681117963, 0.0765136554, 0.022925848, -0.0387008139, -0.0559757779, -0.0265920833, 0.010602952, 0.0226630452, 0.0116100153, 0, 156567e-10, 0.0042944445, 0.0022318354],
        [-2360287e-9, -0.0050929284, -0.0010646763, -0, -9863385e-9, -0.0203015345, -0.0097729069, 0.0249814885, 0.0533472005, 0.037320356, -0.0223351104, -0.0752360963, -0.0675610157, 0, 0.067943833, 0.0761042837, 0.0227333118, -0.0382466012, -0.0551051089, -0.0260556981, 0.010325152, 0.0218688113, 0.0110194475, 0, 3757078e-10, 4572406e-9, 0.0022780649],
        [-0.0023208668, -0.0048385425, -7253831e-10, -0, -0.0104371842, -0.0210815517, -0.0100484346, 0.0255187576, 0.0542287854, 0.0377863769, -0.0225363676, -0.075678361, -0.0677602091, 0, 0.0677602091, 0.075678361, 0.0225363676, -0.0377863769, -0.0542287854, -0.0255187576, 0.0100484346, 0.0210815517, 0.0104371842, 0, 7253831e-10, 0.0048385425, 0.0023208668],
        [-0.0022780649, -4572406e-9, -3757077e-10, -0, -0.0110194475, -0.0218688113, -0.010325152, 0.0260556981, 0.0551051089, 0.0382466012, -0.0227333118, -0.0761042837, -0.067943833, 0, 0.0675610157, 0.0752360963, 0.0223351104, -0.037320356, -0.0533472005, -0.0249814885, 0.0097729069, 0.0203015345, 9863385e-9, 0, 0.0010646763, 0.0050929284, 2360287e-9],
        [-0.0022318354, -0.0042944445, -156567e-10, -0, -0.0116100153, -0.0226630452, -0.010602952, 0.0265920834, 0.0559757779, 0.0387008139, -0.022925848, -0.0765136554, -0.0681117963, 0, 0.0673463515, 0.0747777061, 0.0221296366, -0.0368487558, -0.0524607475, -0.0244441165, 0.0094986751, 0.0195290216, 0.0092982033, 0, 0.0013935872, 0.0053356444, 0.0023963726],
        [-0.0021821342, -400459e-8, 3547575e-10, -0, -0.0122087219, -0.0234639795, -0.0108817259, 0.0271276853, 0.0568404006, 0.0391488021, -0.0231138836, -0.0769062751, -0.0682640158, 0, 0.0671163227, 0.0743034147, 0.0219200448, -0.0363717954, -0.0515698207, -0.023906866, 0.0092258433, 0.0187642687, 0.0087417865, 0, 0.0017121216, 0.0055667771, 0.0024291724],
        [-0.0021289188, -0.0037027809, 7355159e-10, -0, -0.0128153955, -0.0242713342, -0.0111613637, 0.027662275, 0.0576985862, 0.0395903551, -0.0232973276, -0.0772819499, -0.0684004158, 0, 0.0668710432, 0.0738134538, 0.0217064353, -0.0358896958, -0.0506748142, -0.0233699597, 0.0089545147, 0.018007525, 0.0081942754, 0, 0.0020202915, 0.0057864192, 0.0024587365],
        [-0.0020721481, -3388962e-9, 0.0011265932, -0, -0.0134298583, -0.0250848237, -0.0114417544, 0.0281956228, 0.0585499453, 0.0400252649, -0.0234760913, -0.0776404948, -0.0685209288, 0, 0.0666106342, 0.0733080624, 0.0214889098, -0.0354026794, -0.0497761224, -0.022833619, 0.0086847906, 0.0172590335, 0.0076558048, 0, 0.0023181148, 0.0059946694, 0.0024851164]
      ];
      var RX_PULSESHAPER_2400_RE = [
        [-0.0065669843, 0.0052669165, 9952566e-10, 0.0018886601, -0.0027220819, -0.0140519265, 0.022035392, 0.0117227856, -0.0488741394, 0.0183537833, 0.0556792264, -0.0619167343, -0.0253378011, 0.0848257764, -0.0262126065, -0.0663352244, 0.0619167343, 0.021267572, -0.0593940904, 0.0151029396, 0.0306906511, -0.022035392, -0.0053673583, 0.0088088419, -5836281e-10, 0.0026056155, -0.0052669165],
        [-0.0065061191, 0.0050993703, 8854411e-10, 0.0023974435, -0.0029242572, -0.0146814108, 0.0227370771, 0.0120043439, -0.0497761225, 0.01861229, 0.0562586963, -0.0623595625, -0.0254429983, 0.0849352512, -0.0261726658, -0.0660449496, 0.0614612049, 0.021042527, -0.0585499453, 0.0148233161, 0.0299549018, -0.0213384255, -0.0051297494, 0.0081660725, -4303203e-10, 0.0028828232, -0.0054249543],
        [-0.0064370557, 0.0049222222, 7716827e-10, 0.0029188412, -0.0031299347, -0.0153181157, 0.023443224, 0.0122863149, -0.0506748142, 0.0188683297, 0.0568281853, -0.0627894742, -0.0255424656, 0.0850248959, -0.026126634, -0.0657399531, 0.0609931955, 0.0208138814, -0.0576985862, 0.0145429186, 0.0292208295, -0.02064643, -0.0048950455, 0.0075349297, -2809421e-10, 0.0031497736, -0.0055735817],
        [-0.0063596559, 0.0047353834, 6539723e-10, 0.0034527905, -0.0033390653, -0.0159618403, 0.0241535715, 0.0125685832, -0.0515698207, 0.0191217845, 0.0573874224, -0.0632062598, -0.0256361541, 0.0850946657, -0.0260745338, -0.0654203851, 0.0605129328, 0.0205817433, -0.0568404006, 0.0142618681, 0.0284887282, -0.0199596531, -0.0046633168, 0.0069155483, -1355053e-10, 0.0034065078, -0.0057129015],
        [-0.0062737849, 0.0045387702, 5323029e-10, 0.0039992207, -0.0035515976, -0.016612378, 0.0248678542, 0.0128510325, -0.0524607475, 0.0193725374, 0.0579361408, -0.0636097161, -0.0257240173, 0.0851445261, -0.0260163912, -0.0650864028, 0.0600206494, 0.020346222, -0.0559757779, 0.0139802855, 0.0277588887, -0.0192783377, -0.0044346312, 0.0063080551, 59803e-10, 0.0036530727, -0.0058430209],
        [-0.0061793115, 0.0043323037, 4066702e-10, 4558053e-9, -0.0037674778, -0.0172695167, 0.0255858026, 0.0131335457, -0.0533472005, 0.0196204723, 0.0584740781, -0.0639996461, -0.0258060117, 0.0851744523, -0.0259522349, -0.0647381704, 0.0595165829, 0.0201074282, -0.0551051089, 0.0136982911, 0.0270315989, -0.018602722, -0.0042090544, 0.0057125689, 1435076e-10, 0.0038895208, -0.0059640512],
        [-0.0060761082, 0.0041159101, 2770717e-10, 0.0051292006, -0.0039866496, -0.017933039, 0.0263071433, 0.0134160048, -0.0542287854, 0.019865474, 0.0590009765, -0.064375859, -0.0258820968, 0.0851844294, -0.0258820968, -0.064375859, 0.0590009765, 0.019865474, -0.0542287854, 0.0134160048, 0.0263071433, -0.017933039, -0.0039866496, 0.0051292006, 2770717e-10, 0.0041159101, -0.0060761082],
        [-0.0059640512, 0.0038895208, 1435076e-10, 5712569e-9, -0.0042090544, -0.018602722, 0.027031599, 0.0136982911, -0.0551051089, 0.0201074282, 0.0595165829, -0.0647381704, -0.0259522349, 0.0851744523, -0.0258060117, -0.0639996461, 0.0584740781, 0.0196204723, -0.0533472005, 0.0131335457, 0.0255858026, -0.0172695167, -0.0037674778, 4558053e-9, 4066702e-10, 0.0043323037, -0.0061793115],
        [-0.0058430209, 0.0036530727, 59803e-10, 0.0063080551, -0.0044346313, -0.0192783377, 0.0277588887, 0.0139802855, -0.0559757779, 0.020346222, 0.0600206494, -0.0650864028, -0.0260163912, 0.0851445261, -0.0257240173, -0.0636097161, 0.0579361408, 0.0193725374, -0.0524607475, 0.0128510325, 0.0248678542, -0.016612378, -0.0035515976, 0.0039992207, 5323029e-10, 0.0045387702, -0.0062737849],
        [-0.0057129015, 0.0034065078, -1355053e-10, 0.0069155483, -0.0046633168, -0.0199596531, 0.0284887282, 0.0142618681, -0.0568404006, 0.0205817433, 0.0605129328, -0.0654203851, -0.0260745338, 0.0850946657, -0.0256361541, -0.0632062598, 0.0573874224, 0.0191217845, -0.0515698207, 0.0125685832, 0.0241535715, -0.0159618403, -0.0033390653, 0.0034527905, 6539723e-10, 0.0047353834, -0.0063596559],
        [-0.0055735817, 0.0031497736, -2809421e-10, 0.0075349297, -0.0048950455, -0.02064643, 0.0292208296, 0.0145429186, -0.0576985862, 0.0208138814, 0.0609931955, -0.0657399531, -0.026126634, 0.0850248959, -0.0255424656, -0.0627894742, 0.0568281853, 0.0188683297, -0.0506748142, 0.0122863149, 0.023443224, -0.0153181157, -0.0031299347, 0.0029188412, 7716827e-10, 0.0049222222, -0.0064370557],
        [-0.0054249543, 0.0028828232, -4303203e-10, 0.0081660725, -0.0051297494, -0.0213384256, 0.0299549018, 0.0148233161, -0.0585499453, 0.021042527, 0.0614612049, -0.0660449496, -0.0261726658, 0.0849352512, -0.0254429983, -0.0623595625, 0.0562586963, 0.01861229, -0.0497761224, 0.0120043439, 0.0227370771, -0.0146814108, -0.0029242572, 0.0023974435, 8854411e-10, 0.0050993703, -0.0065061191]
      ];
      var RX_PULSESHAPER_2400_IM = [
        [-0.0047711934, -0.0038266388, 0.0030630847, 0, 0.0083777065, -0.0102093222, -0.0160096494, 0.0360790242, -0, -0.0564871367, 0.0404533259, 0.0449851407, -0.0779817332, 0, 0.0806741074, -0.0481953616, -0.0449851407, 0.0654548563, 0, -0.0464820688, 0.0222980632, 0.0160096494, -0.0165190304, -0, 0.0017962225, 0.0018930905, 0.0038266389],
        [-0.0047269722, -0.0037049094, 0.0027251074, 0, 0.0089999383, -0.0106666693, -0.0165194535, 0.0369455716, -0, -0.0572827386, 0.0408743354, 0.0453068742, -0.0783054969, 0, 0.0805511828, -0.0479844647, -0.0446541792, 0.064762239, 0, -0.045621476, 0.0217635101, 0.0155032736, -0.0157877452, -0, 0.0013243898, 0.0020944937, 394146e-8],
        [-0.0046767947, -0.0035762038, 0.0023749951, 0, 0.0096329485, -0.0111292625, -0.0170324992, 0.0378133892, -0, -0.0580707476, 0.0412880934, 0.0456192233, -0.078611626, 0, 0.0804095114, -0.0477628717, -0.0443141504, 0.0640585402, 0, -0.0447585011, 0.0212301754, 0.0150005095, -0.0150654009, -0, 8646507e-10, 0.0022884444, 0.0040494441],
        [-0.0046205605, -0.0034404574, 0.0020127196, 0, 0.0102765864, -0.0115969558, -0.0175485969, 0.0386821218, -0, -0.0588508013, 0.041694403, 0.0459220358, -0.0788999694, 0, 0.0802491635, -0.047530692, -0.0439652192, 0.0633440924, 0, -0.0438935168, 0.0206982726, 0.0145015368, -0.0143522134, -0, 4170424e-10, 0.0024749728, 0.0041506659],
        [-0.0045581716, -0.0032976096, 163826e-8, 0, 0.0109306936, -0.0120695991, -0.0180675536, 0.0395514114, -0, -0.0596225394, 0.0420930702, 0.046215164, -0.0791703844, 0, 0.0800702188, -0.0472880396, -0.0436075544, 0.0626192323, 0, -0.0430268947, 0.0201680132, 0.0140065322, -0.0136483916, -0, -184055e-10, 0.0026541127, 0.0042452032],
        [-0.0044895326, -0.0031476028, 0.0012516021, 0, 0.0115951044, -0.0125470384, -0.0185891737, 0.0404208974, -0, -0.0603856045, 0.0424839045, 0.0464984647, -0.0794227374, 0, 0.0798727661, -0.047035034, -0.0432413286, 0.0618843007, 0, -0.0421590052, 0.0196396062, 0.0135156687, -0.0129541374, -0, -441671e-9, 0.0028259023, 0.0043331369],
        [-4414551e-9, -0.0029903837, 852739e-9, 0, 0.0122696459, -0.0130291155, -0.0191132584, 0.0412902171, -0, -0.0611396421, 0.0428667186, 0.0467717993, -0.0796569033, 0, 0.0796569033, -0.0467717993, -0.0428667186, 0.0611396421, 0, -0.0412902171, 0.0191132583, 0.0130291155, -0.0122696459, -0, -852739e-9, 0.0029903837, 4414551e-9],
        [-0.0043331368, -0.0028259023, 4416709e-10, 0, 0.0129541375, -0.0135156687, -0.0196396062, 0.0421590052, -0, -0.0618843008, 0.0432413286, 0.047035034, -0.0798727661, 0, 0.0794227374, -0.0464984647, -0.0424839045, 0.0603856045, 0, -0.0404208974, 0.0185891737, 0.0125470384, -0.0115951044, -0, -0.0012516021, 0.0031476029, 0.0044895326],
        [-0.0042452032, -0.0026541127, 184055e-10, 0, 0.0136483916, -0.0140065322, -0.0201680132, 0.0430268947, -0, -0.0626192324, 0.0436075544, 0.0472880396, -0.0800702188, 0, 0.0791703844, -0.046215164, -0.0420930702, 0.0596225394, 0, -0.0395514113, 0.0180675536, 0.0120695991, -0.0109306936, -0, -163826e-8, 0.0032976096, 0.0045581716],
        [-0.0041506659, -0.0024749728, -4170424e-10, 0, 0.0143522134, -0.0145015368, -0.0206982726, 0.0438935168, -0, -0.0633440924, 0.0439652192, 0.047530692, -0.0802491635, 0, 0.0788999694, -0.0459220358, -0.041694403, 0.0588508013, 0, -0.0386821217, 0.0175485968, 0.0115969558, -0.0102765864, -0, -0.0020127196, 0.0034404575, 0.0046205605],
        [-0.0040494441, -0.0022884444, -8646507e-10, 0, 0.0150654009, -0.0150005095, -0.0212301754, 0.0447585011, -0, -0.0640585402, 0.0443141504, 0.0477628717, -0.0804095114, 0, 0.078611626, -0.0456192233, -0.0412880934, 0.0580707476, 0, -0.0378133892, 0.0170324992, 0.0111292625, -0.0096329485, -0, -0.0023749951, 0.0035762038, 0.0046767947],
        [-394146e-8, -0.0020944937, -0.0013243898, 0, 0.0157877452, -0.0155032737, -0.0217635101, 0.045621476, -0, -0.064762239, 0.0446541792, 0.0479844647, -0.0805511828, 0, 0.0783054969, -0.0453068742, -0.0408743354, 0.0572827385, 0, -0.0369455716, 0.0165194535, 0.0106666693, -0.0089999383, -0, -0.0027251074, 0.0037049094, 0.0047269722]
      ];
      var RX_PULSESHAPER_COEFF_SETS = 12;
      var RX_PULSESHAPER_FILTER_STEPS = 27;
      module.exports = {
        RX_PULSESHAPER_COEFF_SETS,
        RX_PULSESHAPER_FILTER_STEPS,
        RX_PULSESHAPER_1200_RE,
        RX_PULSESHAPER_1200_IM,
        RX_PULSESHAPER_2400_RE,
        RX_PULSESHAPER_2400_IM
      };
    }
  });

  // vendor/src/dsp/protocols/V22Demodulator.js
  var require_V22Demodulator = __commonJS({
    "vendor/src/dsp/protocols/V22Demodulator.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var {
        SR,
        BAUD,
        SPS,
        CARRIER_LOW,
        CARRIER_HIGH,
        GUARD_FREQ,
        PHASE_CHANGE,
        QUADRANT_POINT,
        RRC_BETA,
        RRC_SPAN,
        rrcImpulse,
        buildRrcTaps,
        RRC,
        V22Scrambler
      } = require_V22Common();
      var {
        RX_PULSESHAPER_COEFF_SETS,
        RX_PULSESHAPER_FILTER_STEPS,
        RX_PULSESHAPER_1200_RE,
        RX_PULSESHAPER_1200_IM,
        RX_PULSESHAPER_2400_RE,
        RX_PULSESHAPER_2400_IM
      } = require_V22RxRRC();
      var RX_AMP_SCALE = 32768;
      var EQUALIZER_LEN = 17;
      var EQUALIZER_PRE_LEN = 8;
      var EQUALIZER_DELTA = 0.25;
      var LMS_LEAK_RATE = 0.9999;
      var POWER_METER_SHIFT = 5;
      var CARRIER_ON_POWER = 6063;
      var CARRIER_OFF_POWER = 1917;
      var POWER_METER_FULL_SCALE = 32767 * 32767;
      var AGC_SCALING_NUMERATOR = 0.18 * 3.6;
      var AGC_INITIAL_SCALING = 5e-4 * 0.025;
      var PHASE_UNITS_TO_RADIANS = 2 * Math.PI / 4294967296;
      var CARRIER_TRACK_P = 8e6 * PHASE_UNITS_TO_RADIANS;
      var CARRIER_TRACK_I_CALLER = 8e3 * PHASE_UNITS_TO_RADIANS;
      var CARRIER_TRACK_I_ANSWERER = 4e4 * PHASE_UNITS_TO_RADIANS;
      var CARRIER_TRACK_I_NORMAL = 8e3 * PHASE_UNITS_TO_RADIANS;
      var RX_EQ_STEP_PER_HALF_BAUD = 40 * RX_PULSESHAPER_COEFF_SETS / (3 * 2);
      var GARDNER_THRESHOLD = 16;
      var GARDNER_STEP_INITIAL = 256;
      var GARDNER_STEP_COARSE = 32;
      var GARDNER_STEP_NORMAL = 4;
      var ROT_45_RE = 0.894427;
      var ROT_45_IM = 0.44721;
      var PHASE_STEPS_RX = [1, 0, 2, 3];
      var SPACE_MAP_V22BIS = [
        [11, 9, 9, 6, 6, 7],
        [10, 8, 8, 4, 4, 5],
        [10, 8, 8, 4, 4, 5],
        [13, 12, 12, 0, 0, 2],
        [13, 12, 12, 0, 0, 2],
        [15, 14, 14, 1, 1, 3]
      ];
      var V22BIS_CONSTELLATION = [
        { re: 1, im: 1 },
        { re: 3, im: 1 },
        { re: 1, im: 3 },
        { re: 3, im: 3 },
        { re: -1, im: 1 },
        { re: -1, im: 3 },
        { re: -3, im: 1 },
        { re: -3, im: 3 },
        { re: -1, im: -1 },
        { re: -3, im: -1 },
        { re: -1, im: -3 },
        { re: -3, im: -3 },
        { re: 1, im: -1 },
        { re: 1, im: -3 },
        { re: 3, im: -1 },
        { re: 3, im: -3 }
      ];
      var RX_TRAINING = {
        NORMAL_OPERATION: 0,
        SYMBOL_ACQUISITION: 1,
        LOG_PHASE: 2,
        // unused in spandsp main path
        UNSCRAMBLED_ONES: 3,
        UNSCRAMBLED_ONES_SUSTAINING: 4,
        SCRAMBLED_ONES_AT_1200: 5,
        SCRAMBLED_ONES_AT_1200_SUSTAINING: 6,
        WAIT_FOR_SCRAMBLED_ONES_AT_2400: 7,
        PARKED: 8
      };
      function msToSymbols(ms) {
        return Math.floor(ms * BAUD / 1e3);
      }
      var PowerMeter = class {
        constructor(shift = POWER_METER_SHIFT) {
          this.shift = shift;
          this.reading = 0;
        }
        reset() {
          this.reading = 0;
        }
        /** Update with one int16-equivalent sample. Returns running power. */
        update(amp) {
          this.reading += amp * amp - this.reading >> this.shift;
          return this.reading;
        }
      };
      var QAMDemodulator = class extends EventEmitter {
        constructor({
          carrier,
          bitsPerSymbol = 2,
          bitRate = 1200,
          // 1200 (V.22) or 2400 (V.22bis); affects S1 detection.
          // When 2400, the demod actively listens for an S1
          // pattern from the remote and can promote
          // _negotiatedBitRate to 2400 internally. When 1200,
          // S1 detection is suppressed and the demod stays
          // committed to 1200 — the right behaviour for plain
          // V.22.
          enableCarrierGate = true,
          debugSink = null
        }) {
          super();
          if (carrier !== CARRIER_LOW && carrier !== CARRIER_HIGH) {
            throw new Error(`Invalid V.22 carrier: ${carrier} (expected ${CARRIER_LOW} or ${CARRIER_HIGH})`);
          }
          if (bitRate !== 1200 && bitRate !== 2400) {
            throw new Error(`Invalid V.22 bitRate: ${bitRate} (expected 1200 or 2400)`);
          }
          this._carrier = carrier;
          this._bps = bitsPerSymbol;
          this._callingParty = carrier === CARRIER_HIGH;
          this._enableCarrierGate = enableCarrierGate;
          this._debugSink = debugSink;
          this._descrambler = new V22Scrambler();
          this._signalPresent = false;
          this._gatedBytes = 0;
          if (this._callingParty) {
            this._rxRrcRe = RX_PULSESHAPER_2400_RE;
            this._rxRrcIm = RX_PULSESHAPER_2400_IM;
          } else {
            this._rxRrcRe = RX_PULSESHAPER_1200_RE;
            this._rxRrcIm = RX_PULSESHAPER_1200_IM;
          }
          this._rrcBuf = new Float32Array(RX_PULSESHAPER_FILTER_STEPS);
          this._rrcStep = 0;
          this._powerMeter = new PowerMeter();
          this._eqCoeffRe = new Float32Array(EQUALIZER_LEN);
          this._eqCoeffIm = new Float32Array(EQUALIZER_LEN);
          this._eqBufRe = new Float32Array(EQUALIZER_LEN);
          this._eqBufIm = new Float32Array(EQUALIZER_LEN);
          this._eqStep = 0;
          this._eqPutStep = 20 - 1;
          this._eqDelta = EQUALIZER_DELTA / EQUALIZER_LEN;
          this._carrierPhase = 0;
          this._carrierBaseRate = 2 * Math.PI * carrier / SR;
          this._carrierPhaseRate = this._carrierBaseRate;
          this._carrierTrackP = CARRIER_TRACK_P;
          this._carrierTrackI = this._callingParty ? CARRIER_TRACK_I_CALLER : CARRIER_TRACK_I_ANSWERER;
          this._agcScaling = AGC_INITIAL_SCALING;
          this._gardnerIntegrate = 0;
          this._gardnerStep = GARDNER_STEP_INITIAL;
          this._totalBaudTimingCorrection = 0;
          this._baudPhase = 0;
          this._training = RX_TRAINING.SYMBOL_ACQUISITION;
          this._trainingCount = 0;
          this._patternRepeats = 0;
          this._lastRawBits = 0;
          this._constellationState = 0;
          this._sixteenWayDecisions = false;
          this._negotiatedBitRate = 1200;
          this._bitRate = bitRate;
          this._uartState = "IDLE";
          this._uartBits = [];
          this._uartCount = 0;
          this._totalSamples = 0;
          this._symbolsSeen = 0;
          this._symbolMagSmoothed = 0;
          this._equalizerCoefficientReset();
        }
        // Diagnostic accessors
        get signalPresent() {
          return this._signalPresent;
        }
        get gatedBytes() {
          return this._gatedBytes;
        }
        get trainingStage() {
          return this._training;
        }
        get totalSamples() {
          return this._totalSamples;
        }
        /** Smoothed RMS-ish magnitude of the post-RRC complex carrier signal,
         *  in normalized-audio units. Calibrated to match the prior demodulator's
         *  `symbolMag` scale (~0.05-0.15 on real V.22 signal); the V22 protocol
         *  module's carrier-detection threshold (V22_REMOTE_MAG_THRESHOLD = 0.02)
         *  is set against this scale. Independent of the demodulator's own
         *  carrier-presence gate and training state machine — it gives the V22
         *  protocol layer a separate handshake-time signal-quality estimate. */
        get symbolMag() {
          return this._symbolMagSmoothed;
        }
        /** Hard reset. Equivalent of spandsp's v22bis_rx_restart. */
        reset() {
          this._descrambler.reset();
          this._signalPresent = false;
          this._gatedBytes = 0;
          this._rrcBuf.fill(0);
          this._rrcStep = 0;
          this._powerMeter.reset();
          this._eqStep = 0;
          this._eqPutStep = 20 - 1;
          this._carrierPhase = 0;
          this._carrierPhaseRate = this._carrierBaseRate;
          this._carrierTrackI = this._callingParty ? CARRIER_TRACK_I_CALLER : CARRIER_TRACK_I_ANSWERER;
          this._agcScaling = AGC_INITIAL_SCALING;
          this._gardnerIntegrate = 0;
          this._gardnerStep = GARDNER_STEP_INITIAL;
          this._totalBaudTimingCorrection = 0;
          this._baudPhase = 0;
          this._training = RX_TRAINING.SYMBOL_ACQUISITION;
          this._trainingCount = 0;
          this._patternRepeats = 0;
          this._lastRawBits = 0;
          this._constellationState = 0;
          this._sixteenWayDecisions = false;
          this._negotiatedBitRate = 1200;
          this._uartState = "IDLE";
          this._uartBits = [];
          this._uartCount = 0;
          this._symbolMagSmoothed = 0;
          this._equalizerCoefficientReset();
        }
        /** Reset only the equalizer coefficients (used on retrain).
         *  Mirror of spandsp's v22bis_equalizer_coefficient_reset. */
        _equalizerCoefficientReset() {
          for (let i = 0; i < EQUALIZER_LEN; i++) {
            this._eqCoeffRe[i] = 0;
            this._eqCoeffIm[i] = 0;
          }
          this._eqCoeffRe[EQUALIZER_PRE_LEN] = 3;
          this._eqDelta = EQUALIZER_DELTA / EQUALIZER_LEN;
        }
        // ─────────────────────────────────────────────────────────────────────
        // Equalizer get / tune
        //
        // The buffer is a circular dot-product: for each tap k, the buffer
        // position is (eqStep + k) % EQUALIZER_LEN. spandsp's
        // cvec_circular_dot_prodf does the same.
        //
        // For tune, the LMS update is:
        //   coeff[k] += eq_delta * conj(buf[k]) * err
        // where err = target - z. spandsp's cvec_circular_lmsf.
        // ─────────────────────────────────────────────────────────────────────
        _equalizerGet() {
          let zRe = 0, zIm = 0;
          let p = this._eqStep;
          for (let k = 0; k < EQUALIZER_LEN; k++) {
            const bRe = this._eqBufRe[p], bIm = this._eqBufIm[p];
            const cRe = this._eqCoeffRe[k], cIm = this._eqCoeffIm[k];
            zRe += bRe * cRe - bIm * cIm;
            zIm += bRe * cIm + bIm * cRe;
            if (++p >= EQUALIZER_LEN) p = 0;
          }
          return { re: zRe, im: zIm };
        }
        _tuneEqualizer(zRe, zIm, tRe, tIm) {
          const eRe = (tRe - zRe) * this._eqDelta;
          const eIm = (tIm - zIm) * this._eqDelta;
          let p = this._eqStep;
          for (let k = 0; k < EQUALIZER_LEN; k++) {
            const bRe = this._eqBufRe[p], bIm = this._eqBufIm[p];
            this._eqCoeffRe[k] = this._eqCoeffRe[k] * LMS_LEAK_RATE + (bRe * eRe + bIm * eIm);
            this._eqCoeffIm[k] = this._eqCoeffIm[k] * LMS_LEAK_RATE + (bRe * eIm - bIm * eRe);
            if (++p >= EQUALIZER_LEN) p = 0;
          }
        }
        // ─────────────────────────────────────────────────────────────────────
        // Carrier tracking PI loop. spandsp track_carrier (lines 266-304).
        //   error = z.im * target.re - z.re * target.im
        //   carrier_phase_rate += track_i * error
        //   carrier_phase      += track_p * error
        // ─────────────────────────────────────────────────────────────────────
        _trackCarrier(zRe, zIm, tRe, tIm) {
          const error = zIm * tRe - zRe * tIm;
          this._carrierPhaseRate += this._carrierTrackI * error;
          this._carrierPhase += this._carrierTrackP * error;
        }
        // ─────────────────────────────────────────────────────────────────────
        // Symbol synchronization (Gardner). spandsp symbol_sync (lines 381-457).
        //   Look at the 3 most recent equalizer-buffer entries (newest, mid,
        //   oldest). For 4-way decisions, rotate by 45° to maximize Gardner
        //   sensitivity. Compute Gardner error metric and integrate.
        //   When |integrate| ≥ THRESHOLD, kick eq_put_step.
        // ─────────────────────────────────────────────────────────────────────
        _symbolSync() {
          let aa = [0, 0, 0];
          let j = this._eqStep;
          for (let i = 0; i < 3; i++) {
            if (--j < 0) j = EQUALIZER_LEN - 1;
            aa[i] = j;
          }
          const newRe = this._eqBufRe[aa[0]], newIm = this._eqBufIm[aa[0]];
          const midRe = this._eqBufRe[aa[1]], midIm = this._eqBufIm[aa[1]];
          const oldRe = this._eqBufRe[aa[2]], oldIm = this._eqBufIm[aa[2]];
          let p, q;
          if (this._sixteenWayDecisions) {
            p = (oldRe - newRe) * midRe;
            q = (oldIm - newIm) * midIm;
          } else {
            const aRe = oldRe * ROT_45_RE - oldIm * ROT_45_IM;
            const aIm = oldRe * ROT_45_IM + oldIm * ROT_45_RE;
            const bRe = midRe * ROT_45_RE - midIm * ROT_45_IM;
            const bIm = midRe * ROT_45_IM + midIm * ROT_45_RE;
            const cRe = newRe * ROT_45_RE - newIm * ROT_45_IM;
            const cIm = newRe * ROT_45_IM + newIm * ROT_45_RE;
            p = (aRe - cRe) * bRe;
            q = (aIm - cIm) * bIm;
          }
          this._gardnerIntegrate += p + q > 0 ? this._gardnerStep : -this._gardnerStep;
          if (Math.abs(this._gardnerIntegrate) >= GARDNER_THRESHOLD) {
            const kick = this._gardnerIntegrate / GARDNER_THRESHOLD | 0;
            this._eqPutStep += kick;
            this._totalBaudTimingCorrection += kick;
            this._gardnerIntegrate = 0;
            if (this._debugSink) {
              this._debugSink({
                type: "gardner_kick",
                t: this._totalSamples / SR,
                kick
              });
            }
          }
        }
        // ─────────────────────────────────────────────────────────────────────
        // Slicer + descrambler. Two flavours, matching spandsp:
        //   decode_baud:  emits bits via put_bit (i.e. user-facing). Used in
        //                 NORMAL_OPERATION only.
        //   decode_baudx: returns bitstream as a 4-bit int, no put_bit.
        //                 Used in training stages for state-machine bookkeeping.
        // ─────────────────────────────────────────────────────────────────────
        _decodeBaud(nearest) {
          const rawBits = PHASE_STEPS_RX[(nearest >> 2) - (this._constellationState >> 2) & 3];
          this._constellationState = nearest;
          this._putBit(this._descrambler.descramble(rawBits >> 1 & 1));
          this._putBit(this._descrambler.descramble(rawBits & 1));
          if (this._sixteenWayDecisions) {
            this._putBit(this._descrambler.descramble(nearest >> 1 & 1));
            this._putBit(this._descrambler.descramble(nearest & 1));
          }
          return rawBits;
        }
        _decodeBaudx(nearest) {
          const rawBits = PHASE_STEPS_RX[(nearest >> 2) - (this._constellationState >> 2) & 3];
          this._constellationState = nearest;
          let outBits = this._descrambler.descramble(rawBits >> 1 & 1);
          outBits = outBits << 1 | this._descrambler.descramble(rawBits & 1);
          if (this._sixteenWayDecisions) {
            outBits = outBits << 1 | this._descrambler.descramble(nearest >> 1 & 1);
            outBits = outBits << 1 | this._descrambler.descramble(nearest & 1);
          }
          return { rawBits, outBits };
        }
        // ─────────────────────────────────────────────────────────────────────
        // Per-half-baud processing. spandsp process_half_baud (lines 459-824).
        // Called once per T/2 (every other call inserts into eqBuf only; the
        // second of each pair triggers full symbol decision and state machine).
        // ─────────────────────────────────────────────────────────────────────
        _processHalfBaud(sampleRe, sampleIm) {
          this._eqBufRe[this._eqStep] = sampleRe;
          this._eqBufIm[this._eqStep] = sampleIm;
          if (++this._eqStep >= EQUALIZER_LEN) this._eqStep = 0;
          this._baudPhase ^= 1;
          if (this._baudPhase) return;
          this._symbolSync();
          const z = this._equalizerGet();
          const prevTraining = this._training;
          const prevNegotiated = this._negotiatedBitRate;
          const prevSixteenWay = this._sixteenWayDecisions;
          let nearest;
          if (this._sixteenWayDecisions) {
            let re = z.re + 3 | 0;
            let im = z.im + 3 | 0;
            if (re > 5) re = 5;
            else if (re < 0) re = 0;
            if (im > 5) im = 5;
            else if (im < 0) im = 0;
            nearest = SPACE_MAP_V22BIS[re][im];
          } else {
            const zzRe = z.re * ROT_45_RE - z.im * ROT_45_IM;
            const zzIm = z.re * ROT_45_IM + z.im * ROT_45_RE;
            nearest = 1;
            if (zzRe < 0) nearest |= 4;
            if (zzIm < 0) {
              nearest ^= 4;
              nearest |= 8;
            }
          }
          let target = V22BIS_CONSTELLATION[nearest];
          let rawBits = 0;
          let bitstream = 0;
          this._symbolsSeen++;
          switch (this._training) {
            case RX_TRAINING.NORMAL_OPERATION: {
              target = V22BIS_CONSTELLATION[nearest];
              this._trackCarrier(z.re, z.im, target.re, target.im);
              this._tuneEqualizer(z.re, z.im, target.re, target.im);
              rawBits = PHASE_STEPS_RX[(nearest >> 2) - (this._constellationState >> 2) & 3];
              if ((this._lastRawBits ^ rawBits) === 3) {
                this._patternRepeats++;
              } else {
                if (this._patternRepeats >= 50 && (this._lastRawBits === 3 || this._lastRawBits === 0)) {
                  this._patternRepeats = 0;
                  this._trainingCount = 0;
                  this._training = RX_TRAINING.SCRAMBLED_ONES_AT_1200;
                  this._equalizerCoefficientReset();
                  if (this._debugSink) {
                    this._debugSink({ type: "retrain", t: this._totalSamples / SR });
                  }
                }
                this._patternRepeats = 0;
              }
              this._decodeBaud(nearest);
              break;
            }
            case RX_TRAINING.SYMBOL_ACQUISITION: {
              target = { re: z.re, im: z.im };
              if (++this._trainingCount >= 40) {
                this._gardnerStep = GARDNER_STEP_NORMAL;
                this._patternRepeats = 0;
                this._training = this._callingParty ? RX_TRAINING.UNSCRAMBLED_ONES : RX_TRAINING.SCRAMBLED_ONES_AT_1200;
                if (this._negotiatedBitRate !== 2400) {
                  this._negotiatedBitRate = 1200;
                }
              } else if (this._trainingCount === 30) {
                this._gardnerStep = GARDNER_STEP_COARSE;
              }
              break;
            }
            case RX_TRAINING.UNSCRAMBLED_ONES: {
              target = V22BIS_CONSTELLATION[nearest];
              this._trackCarrier(z.re, z.im, target.re, target.im);
              rawBits = PHASE_STEPS_RX[(nearest >> 2) - (this._constellationState >> 2) & 3];
              this._constellationState = nearest;
              if (rawBits !== this._lastRawBits) this._patternRepeats = 0;
              else this._patternRepeats++;
              if (++this._trainingCount === msToSymbols(155 + 456)) {
                if (rawBits === this._lastRawBits && (rawBits === 3 || rawBits === 0) && this._patternRepeats >= msToSymbols(456)) {
                }
                this._patternRepeats = 0;
                this._trainingCount = 0;
                this._training = RX_TRAINING.UNSCRAMBLED_ONES_SUSTAINING;
              }
              break;
            }
            case RX_TRAINING.UNSCRAMBLED_ONES_SUSTAINING: {
              target = V22BIS_CONSTELLATION[nearest];
              this._trackCarrier(z.re, z.im, target.re, target.im);
              rawBits = PHASE_STEPS_RX[(nearest >> 2) - (this._constellationState >> 2) & 3];
              this._constellationState = nearest;
              if (rawBits !== this._lastRawBits) {
                this._trainingCount = 0;
                this._training = RX_TRAINING.SCRAMBLED_ONES_AT_1200;
                this._patternRepeats = 0;
              }
              break;
            }
            case RX_TRAINING.SCRAMBLED_ONES_AT_1200: {
              target = V22BIS_CONSTELLATION[nearest];
              this._trackCarrier(z.re, z.im, target.re, target.im);
              this._tuneEqualizer(z.re, z.im, target.re, target.im);
              const decoded = this._decodeBaudx(nearest);
              rawBits = decoded.rawBits;
              bitstream = decoded.outBits;
              this._trainingCount++;
              if (this._negotiatedBitRate === 1200) {
                if ((this._lastRawBits ^ rawBits) === 3) {
                  this._patternRepeats++;
                } else {
                  if (this._patternRepeats >= 15 && (this._lastRawBits === 3 || this._lastRawBits === 0)) {
                    if (this._bitRate === 2400) {
                      if (!this._callingParty) {
                      }
                      this._negotiatedBitRate = 2400;
                    }
                  }
                  this._patternRepeats = 0;
                }
                if (this._trainingCount >= msToSymbols(270)) {
                  if (this._callingParty) {
                    this._training = RX_TRAINING.NORMAL_OPERATION;
                    this._carrierTrackI = CARRIER_TRACK_I_NORMAL;
                  } else {
                    this._training = RX_TRAINING.SCRAMBLED_ONES_AT_1200_SUSTAINING;
                    this._trainingCount = 0;
                  }
                }
              } else {
                if (this._callingParty) {
                  if (this._trainingCount >= msToSymbols(100 + 450)) {
                    this._sixteenWayDecisions = true;
                    this._training = RX_TRAINING.WAIT_FOR_SCRAMBLED_ONES_AT_2400;
                    this._patternRepeats = 0;
                    this._carrierTrackI = CARRIER_TRACK_I_NORMAL;
                  }
                } else {
                  if (this._trainingCount >= msToSymbols(450)) {
                    this._sixteenWayDecisions = true;
                    this._training = RX_TRAINING.WAIT_FOR_SCRAMBLED_ONES_AT_2400;
                    this._patternRepeats = 0;
                  }
                }
              }
              break;
            }
            case RX_TRAINING.SCRAMBLED_ONES_AT_1200_SUSTAINING: {
              target = V22BIS_CONSTELLATION[nearest];
              this._trackCarrier(z.re, z.im, target.re, target.im);
              this._tuneEqualizer(z.re, z.im, target.re, target.im);
              this._decodeBaudx(nearest);
              if (++this._trainingCount > msToSymbols(270 + 765)) {
                this._training = RX_TRAINING.NORMAL_OPERATION;
              }
              break;
            }
            case RX_TRAINING.WAIT_FOR_SCRAMBLED_ONES_AT_2400: {
              target = V22BIS_CONSTELLATION[nearest];
              this._trackCarrier(z.re, z.im, target.re, target.im);
              this._tuneEqualizer(z.re, z.im, target.re, target.im);
              bitstream = this._decodeBaudx(nearest).outBits;
              if (bitstream === 15) {
                if (++this._patternRepeats >= 9) {
                  this._training = RX_TRAINING.NORMAL_OPERATION;
                }
              } else {
                this._patternRepeats = 0;
              }
              break;
            }
            case RX_TRAINING.PARKED:
            default:
              break;
          }
          this._lastRawBits = rawBits;
          if (this._negotiatedBitRate !== prevNegotiated) {
            this.emit("negotiated-rate-change", {
              bitRate: this._negotiatedBitRate
            });
          }
          if (this._sixteenWayDecisions !== prevSixteenWay) {
            this.emit("sixteen-way-change", {
              sixteenWay: this._sixteenWayDecisions
            });
          }
          if (this._training !== prevTraining && this._training === RX_TRAINING.NORMAL_OPERATION) {
            this.emit("training-done", {
              bitRate: this._negotiatedBitRate
            });
          }
          if (this._debugSink) {
            this._debugSink({
              type: "symbol",
              t: this._totalSamples / SR,
              I: z.re,
              Q: z.im,
              nearest,
              training: this._training
            });
          }
        }
        // ─────────────────────────────────────────────────────────────────────
        // Outer per-sample loop. spandsp v22bis_rx (lines 827-980).
        // ─────────────────────────────────────────────────────────────────────
        process(samples) {
          if (!samples || samples.length === 0) return;
          const centerCoeffSet = 6;
          const rrcReCenter = this._rxRrcRe[centerCoeffSet];
          for (let i = 0; i < samples.length; i++) {
            this._totalSamples++;
            const ampScaled = samples[i] * RX_AMP_SCALE;
            this._rrcBuf[this._rrcStep] = ampScaled;
            if (++this._rrcStep >= RX_PULSESHAPER_FILTER_STEPS) this._rrcStep = 0;
            let ii = 0;
            {
              let p = this._rrcStep;
              for (let k = 0; k < RX_PULSESHAPER_FILTER_STEPS; k++) {
                ii += this._rrcBuf[p] * rrcReCenter[k];
                if (++p >= RX_PULSESHAPER_FILTER_STEPS) p = 0;
              }
            }
            const power = this._powerMeter.update(ii);
            this._symbolMagSmoothed = Math.sqrt(power) / RX_AMP_SCALE;
            if (this._signalPresent) {
              if (power < CARRIER_OFF_POWER) {
                this._softCarrierDownReset();
                continue;
              }
            } else {
              if (power < CARRIER_ON_POWER) continue;
              this._signalPresent = true;
              this.emit("carrierUp");
              if (this._debugSink) {
                this._debugSink({ type: "carrier_edge", t: this._totalSamples / SR, edge: "up" });
              }
            }
            if (this._training === RX_TRAINING.PARKED) continue;
            this._eqPutStep -= RX_PULSESHAPER_COEFF_SETS;
            if (this._eqPutStep <= 0) {
              if (this._training === RX_TRAINING.SYMBOL_ACQUISITION) {
                let rootPower = Math.sqrt(power);
                if (rootPower < 1) rootPower = 1;
                this._agcScaling = AGC_SCALING_NUMERATOR / rootPower;
              }
              let step = -this._eqPutStep;
              if (step > RX_PULSESHAPER_COEFF_SETS - 1) step = RX_PULSESHAPER_COEFF_SETS - 1;
              const reCoeff = this._rxRrcRe[step];
              const imCoeff = this._rxRrcIm[step];
              let fii = 0, fqq = 0;
              let p = this._rrcStep;
              for (let k = 0; k < RX_PULSESHAPER_FILTER_STEPS; k++) {
                const x = this._rrcBuf[p];
                fii += x * reCoeff[k];
                fqq += x * imCoeff[k];
                if (++p >= RX_PULSESHAPER_FILTER_STEPS) p = 0;
              }
              const sampleRe = fii * this._agcScaling;
              const sampleIm = fqq * this._agcScaling;
              const cs = Math.cos(this._carrierPhase);
              const sn = Math.sin(this._carrierPhase);
              const zzRe = sampleRe * cs - sampleIm * sn;
              const zzIm = -sampleRe * sn - sampleIm * cs;
              this._eqPutStep += RX_EQ_STEP_PER_HALF_BAUD;
              this._processHalfBaud(zzRe, zzIm);
            }
            this._carrierPhase += this._carrierPhaseRate;
            if (this._carrierPhase >= 2 * Math.PI) {
              this._carrierPhase -= 2 * Math.PI;
            } else if (this._carrierPhase < 0) {
              this._carrierPhase += 2 * Math.PI;
            }
          }
        }
        // Soft-reset on carrier-drop edge.
        //
        // Spandsp's v22bis_rx_restart zeros the rrc filter buffer and power
        // meter on every signal-loss event. That works on clean phone lines,
        // where signal-loss is genuine end-of-call. In our environment, our
        // own TX guard tone (1800 Hz) leaks into the RX path with energy
        // ~400× the actual caller's 1200 Hz signal during early ramp-up.
        // The 1200 Hz bandpass filter rejects 1800 Hz at -36 to -44 dB,
        // but small leak-through pulses cross the carrier-on threshold and
        // dip below it cyclically. If we zero the buffer + power meter on
        // every dip, we then need ~27 samples to refill and re-acquire,
        // creating a self-sustaining ~85 Hz flap during early-call ramp-up.
        //
        // Deliberate deviation from spandsp: keep the rrc buffer and power
        // meter intact across transient down-edges. Reset only the higher-
        // level state (training, equalizer, descrambler, UART). On a real
        // end-of-call, the buffer drains naturally over the next ~27 samples
        // as new (silent) input flushes the old signal samples. On a
        // transient dip, the buffer stays primed and the power meter
        // doesn't need to re-ramp from zero.
        //
        // This is the only architectural deviation from spandsp's RX. The
        // motivation is documented; behavior on clean phone lines (no
        // guard-tone leakage) is unchanged because the gate doesn't flap
        // there in the first place.
        _softCarrierDownReset() {
          if (this._signalPresent) {
            this.emit("carrierDown");
            if (this._debugSink) {
              this._debugSink({ type: "carrier_edge", t: this._totalSamples / SR, edge: "down" });
            }
          }
          this._signalPresent = false;
          this._descrambler.reset();
          this._eqStep = 0;
          this._eqPutStep = 20 - 1;
          this._carrierPhase = 0;
          this._carrierPhaseRate = this._carrierBaseRate;
          this._carrierTrackI = this._callingParty ? CARRIER_TRACK_I_CALLER : CARRIER_TRACK_I_ANSWERER;
          this._agcScaling = AGC_INITIAL_SCALING;
          this._gardnerIntegrate = 0;
          this._gardnerStep = GARDNER_STEP_INITIAL;
          this._totalBaudTimingCorrection = 0;
          this._baudPhase = 0;
          this._training = RX_TRAINING.SYMBOL_ACQUISITION;
          this._trainingCount = 0;
          this._patternRepeats = 0;
          this._lastRawBits = 0;
          this._constellationState = 0;
          this._sixteenWayDecisions = false;
          this._negotiatedBitRate = 1200;
          this._uartState = "IDLE";
          this._uartBits = [];
          this._uartCount = 0;
          this._equalizerCoefficientReset();
        }
        // ─────────────────────────────────────────────────────────────────────
        // UART framer + byte gate.
        //
        // Bits arrive via _putBit (called from _decodeBaud). 1 start bit (0),
        // 8 data bits (LSB first), 1 stop bit (1). We preserve the phase-1
        // resync improvement: emit the byte regardless of stop-bit value,
        // rather than dropping the whole byte on a single stop-bit error.
        //
        // Byte emission gate: only emit while signal_present AND not in
        // training (i.e. NORMAL_OPERATION). The latter is guaranteed by the
        // decode_baud-only-in-NORMAL_OPERATION discipline above, but we keep
        // a defensive check here too.
        // ─────────────────────────────────────────────────────────────────────
        _putBit(bit) {
          if (this._uartState === "IDLE") {
            if (bit === 0) {
              this._uartState = "DATA";
              this._uartBits = [];
              this._uartCount = 0;
            }
          } else if (this._uartState === "DATA") {
            this._uartBits.push(bit);
            if (++this._uartCount === 8) this._uartState = "STOP";
          } else if (this._uartState === "STOP") {
            let byte = 0;
            for (let k = 0; k < 8; k++) byte |= this._uartBits[k] << k;
            const blockedByCarrier = this._enableCarrierGate && !this._signalPresent;
            const blockedByTraining = this._training !== RX_TRAINING.NORMAL_OPERATION;
            if (blockedByCarrier || blockedByTraining) {
              this._gatedBytes++;
            } else {
              this.emit("data", Buffer.from([byte]));
            }
            this._uartState = "IDLE";
          }
        }
      };
      module.exports = {
        QAMDemodulator,
        V22Scrambler,
        // Spec / shared constants — re-exported for backward-compat with V22.js
        // and tools that imported them from V22Demodulator.js previously.
        SR,
        BAUD,
        SPS,
        CARRIER_LOW,
        CARRIER_HIGH,
        GUARD_FREQ,
        PHASE_CHANGE,
        QUADRANT_POINT,
        RRC,
        RRC_BETA,
        RRC_SPAN,
        rrcImpulse,
        buildRrcTaps,
        // RX-specific exports for diagnostics
        RX_TRAINING
      };
    }
  });

  // vendor/src/dsp/protocols/V22.js
  var require_V22 = __commonJS({
    "vendor/src/dsp/protocols/V22.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var config = require_config();
      var ncfg = config.modem.native;
      var V32_DEBUG = typeof process !== "undefined" && process.env && process.env.V32_DEBUG ? true : false;
      var { TWO_PI, BiquadFilter } = require_Primitives();
      var {
        QAMDemodulator,
        V22Scrambler,
        SR,
        BAUD,
        SPS,
        CARRIER_LOW,
        CARRIER_HIGH,
        GUARD_FREQ,
        PHASE_CHANGE,
        QUADRANT_POINT,
        RRC,
        RRC_BETA,
        RRC_SPAN,
        rrcImpulse,
        buildRrcTaps,
        RX_TRAINING
      } = require_V22Demodulator();
      var GUARD_DB = -6;
      var PEAK_TARGET = 0.32;
      function mapSymbol(state, bits, bitsPerSymbol) {
        const q1 = bits[0], q2 = bits[1];
        const phaseIdx = q1 << 1 | q2;
        const dQuadrant = Math.round(PHASE_CHANGE[phaseIdx] / (Math.PI / 2)) % 4;
        state.quadrant = (state.quadrant + dQuadrant) % 4;
        let mag;
        if (bitsPerSymbol === 2) {
          mag = QUADRANT_POINT[1];
        } else {
          const q3 = bits[2], q4 = bits[3];
          mag = QUADRANT_POINT[q3 << 1 | q4];
        }
        let i = mag.i, q = mag.q;
        switch (state.quadrant) {
          case 1: {
            const ni = -q;
            const nq = i;
            i = ni;
            q = nq;
            break;
          }
          case 2: {
            i = -i;
            q = -q;
            break;
          }
          case 3: {
            const ni = q;
            const nq = -i;
            i = ni;
            q = nq;
            break;
          }
        }
        return { i, q };
      }
      var QAMModulator = class {
        /**
         * @param {object} opts
         * @param {number} opts.carrier         1200 or 2400 (Hz)
         * @param {number} opts.bitsPerSymbol   2 (V.22) or 4 (V.22bis)
         * @param {boolean} opts.guardTone      true = emit 1800 Hz guard tone
         */
        constructor({ carrier, bitsPerSymbol, guardTone }) {
          this._carrier = carrier;
          this._bps = bitsPerSymbol;
          this._guardToneOn = !!guardTone;
          this._scrambler = new V22Scrambler();
          this._bitQueue = [];
          this._diffState = { quadrant: 0 };
          this._scramblerBypass = false;
          this._forcedBitFn = null;
          this._symbols = [];
          this._sampleCounter = 0;
          this._nextSymbolAt = 0;
          this._carrierPhase = 0;
          this._carrierInc = TWO_PI * this._carrier / SR;
          this._guardPhase = 0;
          this._guardInc = TWO_PI * GUARD_FREQ / SR;
          const dataLevelAdj = this._guardToneOn ? Math.pow(10, -1 / 20) : 1;
          const rawOuterPeak = 3 * Math.SQRT2 * RRC.gain;
          this._ampData = PEAK_TARGET * dataLevelAdj / rawOuterPeak;
          const dataRmsEst = PEAK_TARGET * dataLevelAdj * 0.45;
          this._ampGuard = dataRmsEst * Math.pow(10, GUARD_DB / 20) * Math.SQRT2;
        }
        reset() {
          this._scrambler.reset();
          this._bitQueue = [];
          this._diffState = { quadrant: 0 };
          this._symbols = [];
          this._sampleCounter = 0;
          this._nextSymbolAt = 0;
          this._carrierPhase = 0;
          this._guardPhase = 0;
          this._scramblerBypass = false;
          this._forcedBitFn = null;
        }
        /**
         * Set handshake TX mode. Modes:
         *   'data'       — normal operation: queued user bytes, scrambled
         *   'unscr-ones' — unscrambled binary 1 (all bits = 1, scrambler bypassed)
         *   'dibit-00'   — unscrambled dibits all = 00 (only meaningful for V.22)
         *   'dibit-11'   — unscrambled dibits all = 11
         *   'alt-00-11'  — alternating dibits 00, 11, 00, 11 (unscrambled)
         *                  (this is the §6.3 "double-dibit 00/11" training signal)
         *   'scr-ones'   — scrambled binary 1 (input = 1 always, scrambler active)
         *
         * Changing mode flushes the pending-bit queue.
         */
        setMode(mode) {
          this._bitQueue = [];
          switch (mode) {
            case "data":
              this._scramblerBypass = false;
              this._forcedBitFn = null;
              break;
            case "unscr-ones":
              this._scramblerBypass = true;
              this._forcedBitFn = () => 1;
              break;
            case "dibit-00":
              this._scramblerBypass = true;
              this._forcedBitFn = () => 0;
              break;
            case "dibit-11":
              this._scramblerBypass = true;
              this._forcedBitFn = () => 1;
              break;
            case "alt-00-11": {
              let n = 0;
              this._scramblerBypass = true;
              this._forcedBitFn = () => n++ >> 1 & 1;
              break;
            }
            case "scr-ones":
              this._scramblerBypass = false;
              this._forcedBitFn = () => 1;
              break;
            default:
              throw new Error("Unknown mode: " + mode);
          }
        }
        /** Queue bytes for asynchronous 10-bit UART framing: start + 8LSB + 2×stop. */
        write(bytes) {
          for (const byte of bytes) {
            this._bitQueue.push(0);
            for (let b = 0; b < 8; b++) this._bitQueue.push(byte >> b & 1);
            this._bitQueue.push(1);
            this._bitQueue.push(1);
          }
        }
        /** True when there are no pending bits (idle marking). */
        get idle() {
          return this._bitQueue.length === 0;
        }
        /**
         * Change the bits-per-symbol during operation. Used by V.22bis handshake
         * to start at 1200 bps (2 bits/symbol) and later switch to 2400 bps
         * (4 bits/symbol). Flushes pending bits to avoid mixed-framing.
         */
        setBitsPerSymbol(bps) {
          if (bps !== 2 && bps !== 4) throw new Error("bps must be 2 or 4");
          this._bps = bps;
          this._bitQueue = [];
        }
        get bitsPerSymbol() {
          return this._bps;
        }
        /** Consume one unscrambled bit from the queue, from _forcedBitFn, or 1 (idle mark). */
        _nextRawBit() {
          if (this._forcedBitFn) return this._forcedBitFn();
          return this._bitQueue.length > 0 ? this._bitQueue.shift() : 1;
        }
        /** Generate the next constellation symbol and append to ring buffer. */
        _generateNextSymbol(startSample) {
          const bits = new Array(this._bps);
          for (let b = 0; b < this._bps; b++) {
            const raw = this._nextRawBit();
            bits[b] = this._scramblerBypass ? raw : this._scrambler.scramble(raw);
          }
          const pt = mapSymbol(this._diffState, bits, this._bps);
          this._symbols.push({ i: pt.i, q: pt.q, startSample });
          const cutoff = startSample - RRC.span;
          while (this._symbols.length > 0 && this._symbols[0].startSample < cutoff) {
            this._symbols.shift();
          }
        }
        /**
         * Generate numSamples of TX audio. The symbol/RRC state is persistent
         * across calls, so a symbol boundary that falls between blocks is
         * handled transparently — the same SRRC-shaped output comes out
         * regardless of how the caller chunks the request.
         */
        generate(numSamples) {
          const out = new Float32Array(numSamples);
          for (let n = 0; n < numSamples; n++) {
            const absSample = this._sampleCounter;
            while (absSample >= this._nextSymbolAt) {
              this._generateNextSymbol(this._nextSymbolAt);
              this._nextSymbolAt += SPS;
            }
            let bbI = 0, bbQ = 0;
            for (let k = 0; k < this._symbols.length; k++) {
              const sym = this._symbols[k];
              const tSym = (absSample - (sym.startSample + RRC_SPAN / 2 * SPS)) / SPS;
              if (Math.abs(tSym) > RRC_SPAN / 2) continue;
              const h = rrcImpulse(tSym, RRC_BETA);
              bbI += sym.i * h;
              bbQ += sym.q * h;
            }
            const cs = Math.cos(this._carrierPhase);
            const sn = Math.sin(this._carrierPhase);
            let sample = this._ampData * (bbI * cs - bbQ * sn);
            if (this._guardToneOn) {
              sample += this._ampGuard * Math.cos(this._guardPhase);
              this._guardPhase += this._guardInc;
              if (this._guardPhase > TWO_PI) this._guardPhase -= TWO_PI;
            }
            this._carrierPhase += this._carrierInc;
            if (this._carrierPhase > TWO_PI) this._carrierPhase -= TWO_PI;
            out[n] = sample;
            this._sampleCounter++;
          }
          return out;
        }
      };
      var V22_HS_PHASE = Object.freeze({
        INIT: "init",
        USB1: "usb1",
        // transmit unscrambled 1s, wait for scrambled from remote
        SB1: "sb1",
        // transmit scrambled 1s for 765ms
        DATA: "data"
        // ready for data
      });
      var V22_REMOTE_MAG_THRESHOLD = 0.02;
      var V22_REMOTE_DETECT_MS = 400;
      var V22_SB1_TX_MS = 2e3;
      var V22_HANDSHAKE_TIMEOUT_MS = 8e3;
      var V22 = class extends EventEmitter {
        constructor(role) {
          super();
          this._role = role;
          const isAnswer = role === "answer";
          const txCarrier = isAnswer ? CARRIER_HIGH : CARRIER_LOW;
          const rxCarrier = isAnswer ? CARRIER_LOW : CARRIER_HIGH;
          this._rxCarrier = rxCarrier;
          this.modulator = new QAMModulator({
            carrier: txCarrier,
            bitsPerSymbol: 2,
            // Guard tone at 1800 Hz is required by V.22bis §2.2 in the
            // high-channel TX (the answerer's TX, which is what we emit
            // here). It is a continuous CW signal that the calling modem's
            // RX uses as a stable AGC and timing reference, distinct from
            // the data carrier.
            //
            // Earlier this was set to `false` with a comment claiming it
            // was "optional" and "may confuse non-strict receivers" — that
            // analysis was wrong on multiple counts:
            //
            //   1. V.22bis spec REQUIRES the guard tone in the high
            //      channel. Optional under V.22 (non-bis), required for
            //      V.22bis interop.
            //   2. The 1800 Hz tone sits OUTSIDE the calling modem's
            //      data-band RX matched filter (centered at 1200 Hz with
            //      ±300 Hz sidebands at 600 baud). Spandsp's 1200 Hz RX
            //      RRC measured -36 dB rejection at 1800 Hz. The guard
            //      tone is by design well outside the data band.
            //   3. The guard tone's purpose is precisely to provide a
            //      continuous CW reference that the calling modem's
            //      AGC/PLL/equalizer can lock onto — particularly during
            //      long idle periods when the data carrier alone (QAM
            //      with random phase changes from the scrambler) gives
            //      the receiver insufficient reference.
            //
            // Symptom of having this disabled: long pure-marking idle
            // periods (e.g. CONNECT> prompt) produced visible terminal
            // garbage on the calling modem's terminal because its
            // descrambler/UART couldn't track stably without the guard-
            // tone reference. BBS data flows look fine because frequent
            // UART start bits provide localized resync points.
            //
            // The slmodemd-pjsip backend doesn't show this issue because
            // its (closed-source) DSP follows the spec and emits the
            // guard tone — that was the user-observation that nailed the
            // root cause.
            // Per V.22bis §2.2 the 1800 Hz guard tone belongs to the HIGH
            // channel — the ANSWERER's TX only. The caller (originate, low
            // channel) must NOT emit it. This class was historically only ever
            // instantiated as the answerer, so this was hard-coded true; making
            // it role-aware is required for the originate side to interoperate
            // (otherwise both ends emit a guard tone and each end's carrier
            // detector is defeated by the other's).
            guardTone: isAnswer
          });
          this.demodulator = new QAMDemodulator({
            carrier: rxCarrier,
            bitsPerSymbol: 2
          });
          this.demodulator.on("data", (buf) => {
            if (this._phase === V22_HS_PHASE.DATA) this.emit("data", buf);
          });
          this._phase = V22_HS_PHASE.INIT;
          this._phaseSamples = 0;
          this._totalSamples = 0;
          this._remoteMagAboveSamp = 0;
          this._remoteDetected = false;
          this._emittedListening = false;
        }
        _enterPhase(phase) {
          this._phase = phase;
          this._phaseSamples = 0;
          switch (phase) {
            case V22_HS_PHASE.USB1:
              this.modulator.setMode("unscr-ones");
              if (!this._emittedListening) {
                this._emittedListening = true;
                this.emit("listening", { phase: "usb1" });
              }
              break;
            case V22_HS_PHASE.SB1:
              this.modulator.setMode("scr-ones");
              break;
            case V22_HS_PHASE.DATA:
              this.modulator.setMode("data");
              this.emit("ready", {
                bps: 1200,
                remoteDetected: this._remoteDetected
              });
              break;
          }
        }
        _advanceHandshake(n) {
          if (this._phase === V22_HS_PHASE.INIT) {
            this._enterPhase(V22_HS_PHASE.USB1);
            return;
          }
          if (this._phase === V22_HS_PHASE.DATA) return;
          this._phaseSamples += n;
          this._totalSamples += n;
          const totalMs = this._totalSamples * 1e3 / SR;
          if (!this._remoteDetected && totalMs >= V22_HANDSHAKE_TIMEOUT_MS) {
            this._enterPhase(V22_HS_PHASE.DATA);
            return;
          }
          if (this._phase === V22_HS_PHASE.USB1) {
            if (this._remoteDetected) {
              this._enterPhase(V22_HS_PHASE.SB1);
            }
            return;
          }
          if (this._phase === V22_HS_PHASE.SB1) {
            const sb1Samples = Math.round(V22_SB1_TX_MS * SR / 1e3);
            if (this._phaseSamples >= sb1Samples) {
              this._enterPhase(V22_HS_PHASE.DATA);
            }
            return;
          }
        }
        _trackRxDetection(samples) {
          const mag = this.demodulator.symbolMag;
          const detectSamples = Math.round(V22_REMOTE_DETECT_MS * SR / 1e3);
          this._goertzelRxCarrier(samples);
          this._goertzelGhost(samples);
          const carrierEnergy = this._carrierEnergy;
          const ghostEnergy = this._ghostEnergy;
          const spectralOK = ncfg.v22MagOnlyDetect ? true : carrierEnergy > 3 * (ghostEnergy + 1e-3);
          const magOK = mag > V22_REMOTE_MAG_THRESHOLD;
          if (V32_DEBUG && !this._remoteDetected) {
            this._diagSampleCount = (this._diagSampleCount || 0) + samples.length;
            if (this._diagSampleCount >= 4e3) {
              this._diagSampleCount = 0;
              const totalMs = (this._totalSamples * 1e3 / SR).toFixed(0);
              process.stderr.write(
                `[V22-SCAN ] t_V22local=${totalMs}ms mag=${mag.toFixed(4)} carrierE=${carrierEnergy.toFixed(4)} ghostE=${ghostEnergy.toFixed(4)} ratio=${(carrierEnergy / (ghostEnergy + 1e-3)).toFixed(2)} magOK=${magOK} specOK=${spectralOK} above=${this._remoteMagAboveSamp || 0}
`
              );
            }
          }
          if (magOK && spectralOK) {
            this._remoteMagAboveSamp += samples.length;
            if (!this._remoteDetected && this._remoteMagAboveSamp >= detectSamples) {
              this._remoteDetected = true;
              if (V32_DEBUG) {
                const totalMs = (this._totalSamples * 1e3 / SR).toFixed(0);
                process.stderr.write(
                  `[V22-DETECT] t_V22local=${totalMs}ms mag=${mag.toFixed(4)} carrierE=${carrierEnergy.toFixed(4)} ghostE=${ghostEnergy.toFixed(4)} ratio=${(carrierEnergy / (ghostEnergy + 1e-3)).toFixed(2)}
`
                );
              }
              this.emit("remote-detected", {
                rms: mag,
                carrierEnergy,
                ghostEnergy
              });
            }
          } else {
            this._remoteMagAboveSamp = 0;
          }
        }
        /** Single-block Goertzel at rxCarrier (stateless — full block). */
        _goertzelRxCarrier(samples) {
          const f = this._rxCarrier;
          const k = 2 * Math.PI * f / SR;
          const c = 2 * Math.cos(k);
          let s1 = 0, s2 = 0;
          for (let i = 0; i < samples.length; i++) {
            const nw = samples[i] + c * s1 - s2;
            s2 = s1;
            s1 = nw;
          }
          const mag = Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / samples.length;
          this._carrierEnergy = (this._carrierEnergy || 0) * 0.8 + mag * 0.2;
        }
        /** Single-block Goertzel at 1800 Hz (ghost tone band). */
        _goertzelGhost(samples) {
          const k = 2 * Math.PI * 1800 / SR;
          const c = 2 * Math.cos(k);
          let s1 = 0, s2 = 0;
          for (let i = 0; i < samples.length; i++) {
            const nw = samples[i] + c * s1 - s2;
            s2 = s1;
            s1 = nw;
          }
          const mag = Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / samples.length;
          this._ghostEnergy = (this._ghostEnergy || 0) * 0.8 + mag * 0.2;
        }
        write(data) {
          this.modulator.write(data);
        }
        generateAudio(n) {
          this._advanceHandshake(n);
          return this.modulator.generate(n);
        }
        receiveAudio(samples) {
          this.demodulator.process(samples);
          this._trackRxDetection(samples);
        }
        reset() {
          this.modulator.reset();
          this.demodulator.reset();
          this._phase = V22_HS_PHASE.INIT;
          this._phaseSamples = 0;
          this._totalSamples = 0;
          this._remoteMagAboveSamp = 0;
          this._remoteDetected = false;
          this._emittedListening = false;
        }
        get name() {
          return "V22";
        }
        get bps() {
          return 1200;
        }
        get phase() {
          return this._phase;
        }
        get ready() {
          return this._phase === V22_HS_PHASE.DATA;
        }
        get remoteDetected() {
          return this._remoteDetected;
        }
        get rxEnergy() {
          return this.demodulator.symbolMag;
        }
      };
      var HS_PHASE = Object.freeze({
        INIT: "init",
        INITIAL_TIMED_SILENCE: "initial_timed_silence",
        U11: "u11",
        U0011: "u0011",
        // S1
        TIMED_S11: "timed_s11",
        S1111: "s1111",
        DATA: "data"
      });
      var HS_DURATION = {
        INITIAL_TIMED_SILENCE: 75,
        // §6.3.1.1.2(a) / spandsp 75 ms
        U0011: 100,
        // S1: 100 ± 3 ms
        // TIMED_S11 has TWO durations depending on whether we got here via
        // the 2400-path or the 1200-fallback path:
        TIMED_S11_2400: 656,
        // 756 - 100 = 656; total elapsed time
        // from U0011 start is 756 ms when this
        // ends. (Spandsp uses
        // `training_count = ms_to_symbols(756 - (600 - 100))`
        // which preloads the 756 ms timer to land
        // 656 ms after U0011 ends.)
        TIMED_S11_1200: 765,
        // §6.3.1.2.2(c): 765 ± 10 ms
        // for V.22 fallback. Used when the demod
        // never sees S1 and times out into 1200
        // committed.
        S1111: 200
        // 200 ± 10 ms
      };
      var V22BIS_REMOTE_MAG_THRESHOLD = 0.02;
      var V22BIS_REMOTE_DETECT_MS = 400;
      var V22BIS_HANDSHAKE_TIMEOUT_MS = 8e3;
      var V22BIS_S1_DETECTOR_WINDOW_MS = 20;
      var V22BIS_S1_DETECTOR_RATIO = 2;
      var V22BIS_S1_DETECTOR_MIN_CARRIER = 5e-3;
      var V22BIS_S1_DETECTOR_RUN_LEN = 4;
      var V22bis = class extends EventEmitter {
        constructor(role) {
          super();
          this._role = role;
          const isAnswer = role === "answer";
          if (!isAnswer) {
          }
          const txCarrier = isAnswer ? CARRIER_HIGH : CARRIER_LOW;
          const rxCarrier = isAnswer ? CARRIER_LOW : CARRIER_HIGH;
          this._rxCarrier = rxCarrier;
          this.modulator = new QAMModulator({
            carrier: txCarrier,
            bitsPerSymbol: 2,
            // start at V.22 rate during handshake
            // Guard tone: per V.22bis §2.2 the 1800 Hz guard tone is emitted by
            // the HIGH channel — the ANSWERER only. As caller (low channel) we
            // must not emit it, or the answerer's carrier detector is defeated
            // (concentrated 1800 Hz CW vs spread DPSK). See the V22 class for the
            // full analysis. Historically hard-coded true because this class only
            // ever ran as the answerer.
            guardTone: isAnswer
          });
          this.demodulator = new QAMDemodulator({
            carrier: rxCarrier,
            bitsPerSymbol: 2,
            // CRITICAL: bitRate=2400 enables the demodulator's own S1
            // detector. Without this, the demod stays committed to 1200
            // even if the caller sends S1 — the V.22 class doesn't pass
            // this so it gets the default 1200 and behaves as plain V.22.
            bitRate: 2400
          });
          this.demodulator.on("negotiated-rate-change", (evt) => {
            if (evt.bitRate === 2400 && this._phase === HS_PHASE.U11) {
              this._onS1Detected("demod");
            }
          });
          this.demodulator.on("training-done", (evt) => {
            if (evt.bitRate === 1200 && this._phase === HS_PHASE.U11) {
              this._negotiatedBps = 1200;
              this._enterPhase(HS_PHASE.TIMED_S11);
            }
          });
          this.demodulator.on("data", (buf) => {
            if (this._phase === HS_PHASE.DATA) this.emit("data", buf);
          });
          this._phase = HS_PHASE.INIT;
          this._phaseSamples = 0;
          this._totalSamples = 0;
          this._remoteMagAboveSamp = 0;
          this._remoteDetected = false;
          this._emittedListening = false;
          this._negotiatedBps = 1200;
          this._s1WinSize = Math.round(V22BIS_S1_DETECTOR_WINDOW_MS * SR / 1e3);
          this._s1Buf = new Float32Array(this._s1WinSize);
          this._s1BufFill = 0;
          this._s1RunLen = 0;
          this._s1Detected = false;
        }
        /**
         * Called when S1 has been detected (either by the demod's symbol-
         * based detector via 'negotiated-rate-change', or by our spectral
         * detector via _runS1Detector). Advances TX to U0011 and pushes
         * the demod into 2400 mode.
         *
         * @param {string} source 'demod' or 'spectral' — for logging.
         */
        _onS1Detected(source) {
          if (this._s1Detected) return;
          if (this._phase !== HS_PHASE.U11) return;
          this._s1Detected = true;
          this._negotiatedBps = 2400;
          this.demodulator._negotiatedBitRate = 2400;
          this.demodulator._patternRepeats = 0;
          if (this.demodulator._training === RX_TRAINING.SCRAMBLED_ONES_AT_1200_SUSTAINING) {
            this.demodulator._training = RX_TRAINING.SCRAMBLED_ONES_AT_1200;
            this.demodulator._trainingCount = 0;
          }
          if (!this._remoteDetected) {
            this._remoteDetected = true;
            this.emit("remote-detected", {
              rms: this.demodulator.symbolMag,
              carrierEnergy: this._carrierEnergy || 0,
              ghostEnergy: this._ghostEnergy || 0,
              viaS1: true
            });
          }
          this.emit("s1-detected", { source });
          this._enterPhase(HS_PHASE.U0011);
        }
        _enterPhase(phase) {
          this._phase = phase;
          this._phaseSamples = 0;
          switch (phase) {
            case HS_PHASE.INITIAL_TIMED_SILENCE:
              this.modulator.setBitsPerSymbol(2);
              this.modulator.setMode("unscr-ones");
              break;
            case HS_PHASE.U11:
              this.modulator.setBitsPerSymbol(2);
              this.modulator.setMode("unscr-ones");
              if (!this._emittedListening) {
                this._emittedListening = true;
                this.emit("listening", { phase: "u11" });
              }
              break;
            case HS_PHASE.U0011:
              this.modulator.setBitsPerSymbol(2);
              this.modulator.setMode("alt-00-11");
              break;
            case HS_PHASE.TIMED_S11:
              this.modulator.setBitsPerSymbol(2);
              this.modulator.setMode("scr-ones");
              break;
            case HS_PHASE.S1111:
              this.modulator.setBitsPerSymbol(4);
              this.modulator.setMode("scr-ones");
              break;
            case HS_PHASE.DATA:
              this.modulator.setBitsPerSymbol(this._negotiatedBps === 2400 ? 4 : 2);
              this.modulator.setMode("data");
              this.emit("ready", {
                bps: this._negotiatedBps,
                remoteDetected: this._remoteDetected
              });
              break;
          }
        }
        _advanceHandshake(n) {
          if (this._phase === HS_PHASE.INIT) {
            this._enterPhase(HS_PHASE.INITIAL_TIMED_SILENCE);
            return;
          }
          if (this._phase === HS_PHASE.DATA) return;
          this._phaseSamples += n;
          this._totalSamples += n;
          const totalMs = this._totalSamples * 1e3 / SR;
          if (!this._remoteDetected && totalMs >= V22BIS_HANDSHAKE_TIMEOUT_MS) {
            this._negotiatedBps = 1200;
            this._enterPhase(HS_PHASE.DATA);
            return;
          }
          switch (this._phase) {
            case HS_PHASE.INITIAL_TIMED_SILENCE: {
              const durSamples = Math.round(HS_DURATION.INITIAL_TIMED_SILENCE * SR / 1e3);
              if (this._phaseSamples >= durSamples) {
                this._enterPhase(HS_PHASE.U11);
              }
              return;
            }
            case HS_PHASE.U11:
              if (this._role !== "answer" && this._remoteDetected && !this._s1Detected) {
                this._onS1Detected("originate-lead");
              }
              return;
            case HS_PHASE.U0011: {
              const durSamples = Math.round(HS_DURATION.U0011 * SR / 1e3);
              if (this._phaseSamples >= durSamples) {
                this._enterPhase(HS_PHASE.TIMED_S11);
              }
              return;
            }
            case HS_PHASE.TIMED_S11: {
              const durMs = this._negotiatedBps === 2400 ? HS_DURATION.TIMED_S11_2400 : HS_DURATION.TIMED_S11_1200;
              const durSamples = Math.round(durMs * SR / 1e3);
              if (this._phaseSamples >= durSamples) {
                if (this._negotiatedBps === 2400) {
                  this._enterPhase(HS_PHASE.S1111);
                } else {
                  this._enterPhase(HS_PHASE.DATA);
                }
              }
              return;
            }
            case HS_PHASE.S1111: {
              const durSamples = Math.round(HS_DURATION.S1111 * SR / 1e3);
              if (this._phaseSamples >= durSamples) {
                this._enterPhase(HS_PHASE.DATA);
              }
              return;
            }
          }
        }
        _trackRxDetection(samples) {
          const mag = this.demodulator.symbolMag;
          const detectSamples = Math.round(V22BIS_REMOTE_DETECT_MS * SR / 1e3);
          this._goertzelRxCarrier(samples);
          this._goertzelGhost(samples);
          this._goertzelFskMark(samples);
          const carrierEnergy = this._carrierEnergy || 0;
          const ghostEnergy = this._ghostEnergy || 0;
          const fskEnergy = this._fskMarkEnergy || 0;
          const spectralOK = ncfg.v22MagOnlyDetect ? true : carrierEnergy > 3 * (ghostEnergy + 1e-3);
          const magOK = mag > V22BIS_REMOTE_MAG_THRESHOLD;
          const notBell103 = fskEnergy <= 4 * carrierEnergy + 2e-3;
          if (magOK && spectralOK && notBell103) {
            this._remoteMagAboveSamp += samples.length;
            if (!this._remoteDetected && this._remoteMagAboveSamp >= detectSamples) {
              this._remoteDetected = true;
              this.emit("remote-detected", {
                rms: mag,
                carrierEnergy,
                ghostEnergy,
                fskEnergy
              });
            }
          } else {
            this._remoteMagAboveSamp = 0;
          }
        }
        _goertzelRxCarrier(samples) {
          const f = this._rxCarrier;
          const k = 2 * Math.PI * f / SR;
          const c = 2 * Math.cos(k);
          let s1 = 0, s2 = 0;
          for (let i = 0; i < samples.length; i++) {
            const nw = samples[i] + c * s1 - s2;
            s2 = s1;
            s1 = nw;
          }
          const mag = Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / samples.length;
          this._carrierEnergy = (this._carrierEnergy || 0) * 0.8 + mag * 0.2;
        }
        _goertzelGhost(samples) {
          const k = 2 * Math.PI * 1800 / SR;
          const c = 2 * Math.cos(k);
          let s1 = 0, s2 = 0;
          for (let i = 0; i < samples.length; i++) {
            const nw = samples[i] + c * s1 - s2;
            s2 = s1;
            s1 = nw;
          }
          const mag = Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / samples.length;
          this._ghostEnergy = (this._ghostEnergy || 0) * 0.8 + mag * 0.2;
        }
        /**
         * Goertzel at 1270 Hz (Bell103 caller mark). When V.22bis is used as
         * a legacy automode probe and the actual caller is a Bell103 modem,
         * the caller's 1270 Hz mark idle leaks into our 1200 Hz carrier bin
         * (the bin is centered at 1200 with ~50 Hz resolution at typical
         * block sizes). An explicit 1270 Hz Goertzel lets us measure the
         * leak source and reject the false detection in _trackRxDetection.
         * We also implicitly cover V.21 (1180 Hz space, 75 Hz away from
         * 1200) — the 1270 Hz Goertzel response at 1180 Hz is small but
         * non-zero, and any real V.21 caller would also leak into 1200 too
         * so the symmetry holds; in practice the spectral-shape test
         * already rejects V.21 at the magnitude level.
         */
        _goertzelFskMark(samples) {
          const k = 2 * Math.PI * 1270 / SR;
          const c = 2 * Math.cos(k);
          let s1 = 0, s2 = 0;
          for (let i = 0; i < samples.length; i++) {
            const nw = samples[i] + c * s1 - s2;
            s2 = s1;
            s1 = nw;
          }
          const mag = Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / samples.length;
          this._fskMarkEnergy = (this._fskMarkEnergy || 0) * 0.8 + mag * 0.2;
        }
        /**
         * Spectral S1 detector. Accumulates RX samples into non-overlapping
         * 20 ms windows; for each completed window, runs Goertzels at the
         * four bins of interest and computes the peaks-vs-valleys ratio.
         * Counts consecutive windows above threshold and fires
         * _onS1Detected('spectral') when the run length reaches
         * V22BIS_S1_DETECTOR_RUN_LEN.
         *
         * Active only during HS_PHASE.U11 — once we've moved past U11 (either
         * via S1 detection or via 1200 fallback) the detector is disabled.
         */
        _runS1Detector(samples) {
          if (this._phase !== HS_PHASE.U11) return;
          if (this._s1Detected) return;
          for (let i = 0; i < samples.length; i++) {
            this._s1Buf[this._s1BufFill++] = samples[i];
            if (this._s1BufFill >= this._s1WinSize) {
              const rxC = this._rxCarrier;
              const m900 = this._goertzelOnS1Buf(rxC - 300);
              const m1500 = this._goertzelOnS1Buf(rxC + 300);
              const m1050 = this._goertzelOnS1Buf(rxC - 150);
              const m1350 = this._goertzelOnS1Buf(rxC + 150);
              const mCar = this._goertzelOnS1Buf(rxC);
              const peaks = (m900 + m1500) / 2;
              const valleys = (m1050 + m1350) / 2;
              const ratio = peaks / (valleys + 1e-3);
              if (ratio > V22BIS_S1_DETECTOR_RATIO && mCar > V22BIS_S1_DETECTOR_MIN_CARRIER) {
                this._s1RunLen++;
                if (this._s1RunLen >= V22BIS_S1_DETECTOR_RUN_LEN) {
                  this._s1BufFill = 0;
                  this._onS1Detected("spectral");
                  return;
                }
              } else {
                this._s1RunLen = 0;
              }
              this._s1BufFill = 0;
            }
          }
        }
        /**
         * Goertzel evaluated over the full _s1Buf (length = _s1WinSize).
         * The buffer is filled linearly (not circular) so iteration is from
         * index 0 to _s1WinSize - 1.
         */
        _goertzelOnS1Buf(freq) {
          const k = 2 * Math.PI * freq / SR;
          const c = 2 * Math.cos(k);
          let s1 = 0, s2 = 0;
          for (let i = 0; i < this._s1WinSize; i++) {
            const nw = this._s1Buf[i] + c * s1 - s2;
            s2 = s1;
            s1 = nw;
          }
          return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / this._s1WinSize;
        }
        write(data) {
          this.modulator.write(data);
        }
        generateAudio(n) {
          this._advanceHandshake(n);
          if (this._phase === HS_PHASE.INITIAL_TIMED_SILENCE) {
            const out = this.modulator.generate(n);
            out.fill(0);
            return out;
          }
          return this.modulator.generate(n);
        }
        receiveAudio(samples) {
          this.demodulator.process(samples);
          this._trackRxDetection(samples);
          this._runS1Detector(samples);
        }
        reset() {
          this.modulator.reset();
          this.demodulator.reset();
          this._phase = HS_PHASE.INIT;
          this._phaseSamples = 0;
          this._totalSamples = 0;
          this._remoteMagAboveSamp = 0;
          this._remoteDetected = false;
          this._emittedListening = false;
          this._negotiatedBps = 1200;
          this._carrierEnergy = 0;
          this._ghostEnergy = 0;
          this._s1Buf.fill(0);
          this._s1BufFill = 0;
          this._s1RunLen = 0;
          this._s1Detected = false;
        }
        get name() {
          return "V22bis";
        }
        get bps() {
          return this._negotiatedBps;
        }
        get phase() {
          return this._phase;
        }
        get ready() {
          return this._phase === HS_PHASE.DATA;
        }
        get remoteDetected() {
          return this._remoteDetected;
        }
        get rxEnergy() {
          return this.demodulator.symbolMag;
        }
      };
      module.exports = {
        V22,
        V22bis,
        QAMModulator,
        QAMDemodulator,
        V22Scrambler,
        HS_PHASE,
        HS_DURATION,
        // Useful constants and helpers for tests and other modules:
        CARRIER_LOW,
        CARRIER_HIGH,
        BAUD,
        SPS,
        PEAK_TARGET,
        GUARD_FREQ,
        PHASE_CHANGE,
        QUADRANT_POINT,
        rrcImpulse,
        buildRrcTaps,
        RRC,
        mapSymbol
      };
    }
  });

  // vendor/src/dsp/protocols/V23.js
  var require_V23 = __commonJS({
    "vendor/src/dsp/protocols/V23.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var config = require_config();
      var { FskModulator, CoherentFskDemodulator } = require_FskCommon();
      var V23CFG = config.modem.native.carriers.V23;
      var V23_FORWARD_BAUD = 1200;
      var V23_BACKWARD_BAUD = 75;
      var V23 = class extends EventEmitter {
        constructor(role) {
          super();
          const isAnswer = role === "answer";
          if (isAnswer) {
            this.modulator = new FskModulator({
              markFreq: V23CFG.forwardMark,
              spaceFreq: V23CFG.forwardSpace,
              baud: V23_FORWARD_BAUD
            });
            this.demodulator = new CoherentFskDemodulator({
              markFreq: V23CFG.backwardMark,
              spaceFreq: V23CFG.backwardSpace,
              baud: V23_BACKWARD_BAUD
            });
          } else {
            this.modulator = new FskModulator({
              markFreq: V23CFG.backwardMark,
              spaceFreq: V23CFG.backwardSpace,
              baud: V23_BACKWARD_BAUD
            });
            this.demodulator = new CoherentFskDemodulator({
              markFreq: V23CFG.forwardMark,
              spaceFreq: V23CFG.forwardSpace,
              baud: V23_FORWARD_BAUD
            });
          }
          this.demodulator.on("data", (buf) => this.emit("data", buf));
          this.demodulator.on("bit", (bit) => this.emit("bit", bit));
        }
        /** Write data bytes to be transmitted (UART-framed: start + 8 data
         *  LSB-first + stop). */
        write(data) {
          this.modulator.write(data);
        }
        /** Write raw bits (no UART framing). */
        writeBits(bits) {
          this.modulator.writeBits(bits);
        }
        /** Generate n samples of transmit audio. */
        generateAudio(n) {
          return this.modulator.generate(n);
        }
        /** Process received audio samples. */
        receiveAudio(samples) {
          this.demodulator.process(samples);
        }
        /** True if RX carrier is currently detected. */
        get carrierDetected() {
          return this.demodulator.carrierDetected;
        }
        get name() {
          return "V23";
        }
        /** Nominal forward-channel rate; data-mode throughput from the
         *  host's perspective. */
        get bps() {
          return V23_FORWARD_BAUD;
        }
      };
      module.exports = { V23 };
    }
  });

  // vendor/src/dsp/protocols/V29.js
  var require_V29 = __commonJS({
    "vendor/src/dsp/protocols/V29.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var SR = 8e3;
      var BAUD = 2400;
      var FC = 1700;
      var SPS = SR / BAUD;
      var ROLLOFF = 0.25;
      var SPAN = 10;
      var C = [
        { i: 3, q: 0 },
        { i: 1, q: 1 },
        { i: 0, q: 3 },
        { i: -1, q: 1 },
        { i: -3, q: 0 },
        { i: -1, q: -1 },
        { i: 0, q: -3 },
        { i: 1, q: -1 },
        { i: 5, q: 0 },
        { i: 3, q: 3 },
        { i: 0, q: 5 },
        { i: -3, q: 3 },
        { i: -5, q: 0 },
        { i: -3, q: -3 },
        { i: 0, q: -5 },
        { i: 3, q: -3 }
      ];
      var DPHASE = { 1: 0, 0: 1, 2: 2, 3: 3, 7: 4, 6: 5, 4: 6, 5: 7 };
      var DINV = {};
      for (const k in DPHASE) DINV[DPHASE[k]] = +k;
      function rrcAt(t) {
        const b = ROLLOFF;
        if (Math.abs(t) < 1e-8) return 1 - b + 4 * b / Math.PI;
        if (Math.abs(Math.abs(4 * b * t) - 1) < 1e-6) {
          return b / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * b)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * b)));
        }
        const pt = Math.PI * t;
        return (Math.sin(pt * (1 - b)) + 4 * b * t * Math.cos(pt * (1 + b))) / (pt * (1 - 4 * b * t * (4 * b * t)));
      }
      var RRC_G = 1;
      {
        let s = 0;
        for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2;
        RRC_G = 1 / Math.sqrt(s / 4);
      }
      var rrc = (t) => rrcAt(t) * RRC_G;
      var SEG_A = 32;
      var SEG_B = 16;
      var PRE = SEG_A + SEG_B;
      var WARMUP_BITS = 40;
      var TRAILER_SYMS = 12;
      var MAX_BURST_BYTES = 256;
      var KEEPALIVE_GAP = Math.round(1.2 * SR);
      var TURNAROUND_GUARD = 360;
      var RX_A = 0.02;
      var RX_HI = 0.015;
      var RX_LO = 6e-3;
      var RX_HANG = 48;
      var ACQ_MIN = Math.ceil((PRE + 10) * SPS);
      var UART_ARM_MARKS = 8;
      var ANS_TONE_FREQ = 2100;
      var ANS_TONE_AMP = 0.15;
      var ANS_TONE_SAMPLES = Math.round(1 * SR);
      var LONGTRAIN_SEG1 = Math.round(0.05 * BAUD);
      var LONGTRAIN_ALT = Math.round(0.2 * BAUD);
      var CONNECT_GAP = Math.round(0.08 * SR);
      var ORIG_LEAD = Math.round(0.6 * SR);
      var V29 = class extends EventEmitter {
        constructor(role) {
          super();
          this.role = role || "answer";
          this._ready = false;
          this.txByteQ = [];
          this.scr = new Array(23).fill(0);
          this.txState = "idle";
          this.txMode = "qam";
          this._connectQ = this._buildConnectScript(this.role);
          this._idleSamples = 0;
          this._resetTxBurst();
          this.rxLevel = 0;
          this.rxOn = false;
          this.rxLow = 0;
          this._resetRx();
        }
        get carrierDetected() {
          return this.rxOn || this.acq;
        }
        get bps() {
          return 9600;
        }
        write(bytes) {
          for (const by of bytes) this.txByteQ.push(by & 255);
        }
        // ─── TX ──────────────────────────────────────────────────────────────────
        _scramble(bit) {
          const r = this.scr;
          const out = bit ^ r[17] ^ r[22];
          r.unshift(out);
          r.pop();
          return out;
        }
        _resetTxBurst() {
          this.txSyms = [];
          this.txMode = "qam";
          this.txBurstN = 0;
          this.txPhase = 0;
          this.txFrame = null;
          this.txFramePos = 0;
          this.txWarmup = 0;
          this.txBurstBytes = 0;
          this.txDataDone = false;
          this.txTrailerSyms = 0;
          this.txEndSample = -1;
        }
        _buildPreamble() {
          for (let k = 0; k < SEG_A; k++) this.txSyms.push(k & 1 ? 12 : 8);
          for (let k = 0; k < SEG_B; k++) this.txSyms.push(8);
        }
        // The connect pre-roll: an ordered list of NON-syncing bursts played once at
        // turn-on, each preceded by `gap` idle samples. The answerer leads with the
        // 2100 Hz answer tone; both sides then emit a long training burst (the harsh
        // "static") before the short 'lock' preamble the receiver actually acquires
        // on. Because tone/longtrain never present an alternating->constant frame-sync
        // boundary, the peer's squelch simply discards them on the following guard —
        // the proven per-burst acquisition path is untouched.
        _buildConnectScript(role) {
          if (role === "answer") {
            return [
              { kind: "tone", gap: 0 },
              // answerer picks up: V.25 answer tone
              { kind: "longtrain", gap: CONNECT_GAP },
              // then drops into V.29 training
              { kind: "lock", gap: CONNECT_GAP }
              // short preamble the peer locks on
            ];
          }
          return [
            { kind: "longtrain", gap: ORIG_LEAD },
            // wait out the tone, then train
            { kind: "lock", gap: CONNECT_GAP }
          ];
        }
        // Long training burst: a short unmodulated-carrier lead-in (SEG1, constant
        // (5,0)) followed by a run of 0°/180° reversals. It starts const->alternating
        // and ends alternating->silence, so it never yields the alternating->constant
        // boundary the frame-sync scanner looks for: the peer hears it but never syncs.
        _buildLongTrain() {
          for (let k = 0; k < LONGTRAIN_SEG1; k++) this.txSyms.push(8);
          for (let k = 0; k < LONGTRAIN_ALT; k++) this.txSyms.push(k & 1 ? 12 : 8);
        }
        _startBurst(kind) {
          this._resetTxBurst();
          this.scr.fill(0);
          if (kind === "tone") {
            this.txMode = "tone";
            this.txEndSample = ANS_TONE_SAMPLES;
            this.txState = "active";
            this._idleSamples = 0;
            return;
          }
          if (kind === "longtrain") {
            this._buildLongTrain();
            this.txDataDone = true;
            this.txEndSample = Math.ceil((this.txSyms.length + SPAN / 2) * SPS);
            this.txState = "active";
            this._idleSamples = 0;
            return;
          }
          this.txWarmup = WARMUP_BITS;
          this._buildPreamble();
          if (kind === "lock" || kind === "train") this.txDataDone = true;
          this.txState = "active";
          this._idleSamples = 0;
        }
        _maybeStartBurst() {
          if (this._connectQ.length) {
            if (this._idleSamples < this._connectQ[0].gap) return;
            this._startBurst(this._connectQ.shift().kind);
            return;
          }
          if (this._idleSamples < TURNAROUND_GUARD) return;
          if (this.txByteQ.length && !this.rxOn) {
            this._startBurst("data");
            return;
          }
          if (!this.rxOn && this._idleSamples >= KEEPALIVE_GAP) {
            this._startBurst("train");
            return;
          }
        }
        // Next framed+scrambled TX bit. Sets txDataDone when it begins trailer marks.
        _txBit() {
          if (this.txWarmup > 0) {
            this.txWarmup--;
            return this._scramble(1);
          }
          if (this.txFrame) {
            const b = this.txFrame[this.txFramePos++];
            if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
            return this._scramble(b);
          }
          if (!this.txDataDone && this.txBurstBytes < MAX_BURST_BYTES && this.txByteQ.length) {
            const by = this.txByteQ.shift();
            this.txBurstBytes++;
            this.txFrame = [
              0,
              by & 1,
              by >> 1 & 1,
              by >> 2 & 1,
              by >> 3 & 1,
              by >> 4 & 1,
              by >> 5 & 1,
              by >> 6 & 1,
              by >> 7 & 1,
              1
            ];
            this.txFramePos = 1;
            return this._scramble(0);
          }
          this.txDataDone = true;
          return this._scramble(1);
        }
        _ensureSymbols(k) {
          while (this.txSyms.length <= k) {
            if (this.txEndSample >= 0) break;
            const Q1 = this._txBit(), Q2 = this._txBit(), Q3 = this._txBit(), Q4 = this._txBit();
            this.txPhase = this.txPhase + DPHASE[Q2 << 2 | Q3 << 1 | Q4] & 7;
            this.txSyms.push(Q1 << 3 | this.txPhase);
            if (this.txDataDone) {
              this.txTrailerSyms++;
              if (this.txTrailerSyms >= TRAILER_SYMS) {
                this.txEndSample = Math.ceil(this.txSyms.length * SPS);
              }
            }
          }
        }
        generateAudio(count) {
          const out = new Float32Array(count);
          if (this.txState !== "active") {
            this._maybeStartBurst();
            if (this.txState !== "active") {
              this._idleSamples += count;
              return out;
            }
          }
          if (this.txMode === "tone") {
            for (let c = 0; c < count; c++) {
              const bn = this.txBurstN++;
              if (this.txEndSample >= 0 && bn >= this.txEndSample) {
                this.txState = "idle";
                this._resetTxBurst();
                break;
              }
              out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * bn / SR) * ANS_TONE_AMP;
            }
            return out;
          }
          for (let c = 0; c < count; c++) {
            const bn = this.txBurstN++;
            if (this.txEndSample >= 0 && bn >= this.txEndSample) {
              this.txState = "idle";
              this._resetTxBurst();
              break;
            }
            const st = bn / SPS;
            const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
            this._ensureSymbols(khi);
            let ai = 0, aq = 0;
            const top = Math.min(khi, this.txSyms.length - 1);
            for (let k = klo; k <= top; k++) {
              const p = rrc(st - k);
              const s = C[this.txSyms[k]];
              ai += s.i * p;
              aq += s.q * p;
            }
            const ph = 2 * Math.PI * FC * bn / SR;
            out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * 0.06;
          }
          return out;
        }
        // ─── RX ──────────────────────────────────────────────────────────────────
        _resetRx() {
          this.rx = [];
          this.rxBase = 0;
          this.acq = false;
          this.base = 0;
          this.symIdx = 0;
          this.des = new Array(23).fill(0);
          this.rxPhase = 0;
          this.prevAng = 0;
          this.A = 1;
          this.outbits = [];
          this.uState = "hunt";
          this.uArmed = false;
          this.uMarks = 0;
          this.uBit = 0;
          this.uByte = 0;
        }
        _bb(n) {
          const ph = 2 * Math.PI * FC * n / SR;
          const s = this.rx[n - this.rxBase];
          return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2];
        }
        _sym(pos) {
          const end = this.rxBase + this.rx.length - 1;
          const nlo = Math.max(this.rxBase, Math.ceil(pos - SPAN / 2 * SPS));
          const nhi = Math.min(end, Math.floor(pos + SPAN / 2 * SPS));
          let ai = 0, aq = 0;
          for (let n = nlo; n <= nhi; n++) {
            const b = this._bb(n);
            const p = rrc((n - pos) / SPS);
            ai += b[0] * p;
            aq += b[1] * p;
          }
          return [ai, aq];
        }
        receiveAudio(f32) {
          for (let i = 0; i < f32.length; i++) {
            const s = f32[i];
            this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
            if (this.rxLevel > RX_HI) {
              this.rxOn = true;
              this.rxLow = 0;
            } else if (this.rxLevel < RX_LO && this.rxOn) {
              this.rxLow++;
            }
            if (this.rxOn) this.rx.push(s);
            if (this.rxOn && this.rxLow > RX_HANG) {
              this._process();
              this.rxOn = false;
              this._resetRx();
            }
          }
          if (this.rxOn) this._process();
        }
        _process() {
          if (!this.acq) {
            if (this.rx.length < ACQ_MIN) return;
            let onset = -1, e = 0;
            for (let n = 0; n < this.rx.length; n++) {
              const b = this._bb(n);
              const m = Math.hypot(b[0], b[1]);
              e = 0.85 * e + 0.15 * m;
              if (e > 0.04) {
                onset = Math.max(0, n - 4);
                break;
              }
            }
            if (onset < 0) return;
            let best = onset, bestScore = -1;
            for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 16) {
              let sc = 0;
              for (let k = 0; k < 12; k++) {
                const s = this._sym(bo + k * SPS);
                sc += Math.hypot(s[0], s[1]);
              }
              if (sc > bestScore) {
                bestScore = sc;
                best = bo;
              }
            }
            const nSy = PRE + 8, ang = [], mag = [];
            for (let j = 0; j < nSy; j++) {
              const s = this._sym(best + j * SPS);
              ang.push(Math.atan2(s[1], s[0]));
              mag.push(Math.hypot(s[0], s[1]));
            }
            const dphi = [];
            for (let j = 1; j < nSy; j++) {
              let d = ang[j] - ang[j - 1];
              while (d > Math.PI) d -= 2 * Math.PI;
              while (d < -Math.PI) d += 2 * Math.PI;
              dphi.push(Math.abs(d));
            }
            let jB = -1;
            for (let j = 3; j < dphi.length - 4; j++) {
              const preAlt = dphi[j - 1] > 2 && dphi[j - 2] > 2;
              const nowConst = dphi[j] < 0.6 && dphi[j + 1] < 0.6 && dphi[j + 2] < 0.6;
              if (preAlt && nowConst) {
                jB = j;
                break;
              }
            }
            if (jB < 0) return;
            let gm = 0, cnt = 0;
            for (let j = jB + 1; j < jB + SEG_B - 1 && j < nSy; j++) {
              gm += mag[j];
              cnt++;
            }
            this.A = gm / Math.max(1, cnt) / 5;
            const dataStart = jB + SEG_B;
            this.base = best;
            this.symIdx = dataStart;
            this.prevAng = ang[dataStart - 1];
            this.rxPhase = 0;
            this.acq = true;
            if (!this._ready) {
              this._ready = true;
              this.emit("ready", { bps: 9600, remoteDetected: true });
            }
          }
          while (true) {
            const pos = this.base + this.symIdx * SPS;
            const end = this.rxBase + this.rx.length - 1;
            if (pos + SPAN / 2 * SPS >= end) break;
            const s = this._sym(pos);
            const mag = Math.hypot(s[0], s[1]);
            if (mag < 0.6 * this.A) break;
            const ang = Math.atan2(s[1], s[0]);
            let d = Math.round((ang - this.prevAng) / (Math.PI / 4));
            d = d % 8 + 8 & 7;
            this.prevAng = ang;
            this.rxPhase = this.rxPhase + d & 7;
            const Q234 = DINV[d];
            const r = mag / this.A;
            const thr = this.rxPhase & 1 ? (Math.SQRT2 + 3 * Math.SQRT2) / 2 : 4;
            const Q1 = r > thr ? 1 : 0;
            const bits = [Q1, Q234 >> 2 & 1, Q234 >> 1 & 1, Q234 & 1];
            for (const bit of bits) {
              const r2 = this.des;
              const ob = bit ^ r2[17] ^ r2[22];
              r2.unshift(bit);
              r2.pop();
              this.outbits.push(ob);
            }
            this.symIdx++;
            this._uartConsume();
          }
        }
        // Async start/stop deframer over the descrambled bit stream. Idle mark (1s)
        // — preamble tail, warm-up, inter-byte gaps, trailer — produces no bytes.
        _uartConsume() {
          while (this.outbits.length) {
            const bit = this.outbits.shift();
            if (this.uState === "hunt") {
              if (bit === 1) {
                if (!this.uArmed && this.uMarks < 255 && ++this.uMarks >= UART_ARM_MARKS) this.uArmed = true;
              } else if (this.uArmed) {
                this.uState = "data";
                this.uBit = 0;
                this.uByte = 0;
              }
            } else if (this.uState === "data") {
              this.uByte |= bit << this.uBit;
              this.uBit++;
              if (this.uBit === 8) this.uState = "stop";
            } else {
              if (bit === 1) {
                this.emit("data", Buffer.from([this.uByte & 255]));
                this.uState = "hunt";
              } else {
                this.uState = "hunt";
                this.uArmed = false;
                this.uMarks = 0;
              }
            }
          }
        }
      };
      module.exports = { V29 };
    }
  });

  // vendor/src/dsp/protocols/V32.js
  var require_V32 = __commonJS({
    "vendor/src/dsp/protocols/V32.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var SR = 8e3;
      var BAUD = 2400;
      var FC = 1800;
      var SPS = SR / BAUD;
      var ROLLOFF = 0.25;
      var SPAN = 10;
      var BASE = [{ i: 1, q: 1 }, { i: 1, q: 3 }, { i: 3, q: 1 }, { i: 3, q: 3 }];
      function rotCCW(i, q, y) {
        switch (y & 3) {
          case 0:
            return { i, q };
          case 1:
            return { i: -q, q: i };
          case 2:
            return { i: -i, q: -q };
          default:
            return { i: q, q: -i };
        }
      }
      function rotCW(i, q, y) {
        switch (y & 3) {
          case 0:
            return { i, q };
          case 1:
            return { i: q, q: -i };
          case 2:
            return { i: -i, q: -q };
          default:
            return { i: -q, q: i };
        }
      }
      function quadOf(i, q) {
        if (i > 0 && q > 0) return 0;
        if (i < 0 && q > 0) return 1;
        if (i < 0 && q < 0) return 2;
        return 3;
      }
      function level(v) {
        return v >= 2 ? 3 : v >= 0 ? 1 : v >= -2 ? -1 : -3;
      }
      var REF = { i: 3, q: 3 };
      function rrcAt(t) {
        const b = ROLLOFF;
        if (Math.abs(t) < 1e-8) return 1 - b + 4 * b / Math.PI;
        if (Math.abs(Math.abs(4 * b * t) - 1) < 1e-6) {
          return b / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * b)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * b)));
        }
        const pt = Math.PI * t;
        return (Math.sin(pt * (1 - b)) + 4 * b * t * Math.cos(pt * (1 + b))) / (pt * (1 - 4 * b * t * (4 * b * t)));
      }
      var RRC_G = 1;
      {
        let s = 0;
        for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2;
        RRC_G = 1 / Math.sqrt(s / 4);
      }
      var rrc = (t) => rrcAt(t) * RRC_G;
      var TX_GAIN = 0.09;
      var SEG_A = 48;
      var SEG_B = 24;
      var PRE = SEG_A + SEG_B;
      var WARMUP_BITS = 40;
      var UART_ARM_MARKS = 8;
      var RX_A = 0.02;
      var RX_HI = 0.015;
      var RX_LO = 6e-3;
      var RX_HANG = 48;
      var ACQ_MIN = Math.ceil((PRE + 10) * SPS);
      var DLE = 16;
      var CTL_RATE = 82;
      var CTL_DATA = 68;
      var RATE_CODE = 9600 / 100;
      var RATE_FRAME = [DLE, CTL_RATE, RATE_CODE >> 8 & 255, RATE_CODE & 255];
      var DATA_MARK = [DLE, CTL_DATA];
      var RATE_REPEATS = 3;
      var ANS_TONE_FREQ = 2100;
      var ANS_TONE_AMP = 0.15;
      var ANS_TONE_SAMPLES = Math.round(1 * SR);
      var AATRAIN_SEG1 = Math.round(0.05 * BAUD);
      var AATRAIN_ALT = Math.round(0.2 * BAUD);
      var CONNECT_GAP = Math.round(0.08 * SR);
      var ORIG_LEAD = Math.round(0.6 * SR);
      var V32 = class extends EventEmitter {
        constructor(role) {
          super();
          this.role = role === "originate" ? "originate" : "answer";
          this._ready = false;
          if (this.role === "originate") {
            this._txTap = 17;
            this._rxTap = 4;
          } else {
            this._txTap = 4;
            this._rxTap = 17;
          }
          this.txByteQ = [];
          this.txCtrlQ = [];
          this.scr = new Array(23).fill(0);
          this.txState = "idle";
          this.txMode = "qam";
          this._connectQ = this._buildConnectScript(this.role);
          this._idleSamples = 0;
          this._resetTxBurst();
          this.rxLevel = 0;
          this.rxOn = false;
          this.rxLow = 0;
          this.peerRate = 0;
          this._resetRx();
        }
        get carrierDetected() {
          return this.rxOn || this.acq;
        }
        get bps() {
          return 9600;
        }
        write(bytes) {
          for (const by of bytes) this.txByteQ.push(by & 255);
        }
        // ─── scrambler / descrambler (self-synchronising, multiplicative) ──────────
        _scramble(bit) {
          const r = this.scr;
          const out = bit ^ r[this._txTap] ^ r[22];
          r.unshift(out);
          r.pop();
          return out;
        }
        // ─── TX ────────────────────────────────────────────────────────────────────
        _resetTxBurst() {
          this.txSyms = [];
          this.txSymBase = 0;
          this.txMode = "qam";
          this.txN = 0;
          this.txPrevY = 0;
          this.txFrame = null;
          this.txFramePos = 0;
          this.txWarmup = 0;
          this.txEndSample = -1;
          this.txContinuous = false;
          this.txPreDone = false;
        }
        _buildPreamble() {
          for (let k = 0; k < SEG_A; k++) this.txSyms.push(k & 1 ? { i: -3, q: -3 } : { i: 3, q: 3 });
          for (let k = 0; k < SEG_B; k++) this.txSyms.push({ i: 3, q: 3 });
        }
        // Ordered non-syncing pre-roll bursts, each preceded by `gap` idle samples.
        // The answerer leads with the 2100 Hz answer tone; both then emit the harsh
        // AA training; the final 'data' item lays the acquirable preamble and then
        // FLOWS INTO CONTINUOUS DATA (it never turns the carrier off again — that is
        // what makes this full-duplex rather than V.29's ping-pong).
        _buildConnectScript(role) {
          if (role === "answer") {
            return [
              { kind: "tone", gap: 0 },
              { kind: "train", gap: CONNECT_GAP },
              { kind: "data", gap: CONNECT_GAP }
            ];
          }
          return [
            { kind: "train", gap: ORIG_LEAD },
            { kind: "data", gap: CONNECT_GAP }
          ];
        }
        // Harsh AA training: short unmodulated 1800 Hz carrier then 0°/180° reversals.
        // Goes const->alternating then alternating->silence, so it never yields the
        // alternating->constant boundary the frame-sync scanner locks on.
        _buildAATrain() {
          for (let k = 0; k < AATRAIN_SEG1; k++) this.txSyms.push({ i: 3, q: 3 });
          for (let k = 0; k < AATRAIN_ALT; k++) this.txSyms.push(k & 1 ? { i: -3, q: -3 } : { i: 3, q: 3 });
        }
        _startBurst(kind) {
          this._resetTxBurst();
          this.scr.fill(0);
          if (kind === "tone") {
            this.txMode = "tone";
            this.txEndSample = ANS_TONE_SAMPLES;
            this.txState = "active";
            this._idleSamples = 0;
            return;
          }
          if (kind === "train") {
            this._buildAATrain();
            this.txEndSample = Math.ceil((this.txSyms.length + SPAN / 2) * SPS);
            this.txState = "active";
            this._idleSamples = 0;
            return;
          }
          this._buildPreamble();
          this.txPrevY = 0;
          this.txWarmup = WARMUP_BITS;
          this.txContinuous = true;
          this.txCtrlQ = [];
          for (let r = 0; r < RATE_REPEATS; r++) this.txCtrlQ.push(...RATE_FRAME);
          this.txCtrlQ.push(...DATA_MARK);
          this.txState = "active";
          this._idleSamples = 0;
        }
        _maybeStartBurst() {
          if (this._connectQ.length) {
            if (this._idleSamples < this._connectQ[0].gap) return;
            this._startBurst(this._connectQ.shift().kind);
            return;
          }
        }
        // Next framed+scrambled TX bit. Warm-up marks, then control bytes (rate
        // signals), then user bytes, then idle mark — all async start/stop framed.
        _txBit() {
          if (this.txWarmup > 0) {
            this.txWarmup--;
            return this._scramble(1);
          }
          if (this.txFrame) {
            const b = this.txFrame[this.txFramePos++];
            if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
            return this._scramble(b);
          }
          let by = null;
          if (this.txCtrlQ.length) by = this.txCtrlQ.shift();
          else if (this.txByteQ.length) by = this.txByteQ.shift();
          if (by !== null) {
            this.txFrame = [
              0,
              by & 1,
              by >> 1 & 1,
              by >> 2 & 1,
              by >> 3 & 1,
              by >> 4 & 1,
              by >> 5 & 1,
              by >> 6 & 1,
              by >> 7 & 1,
              1
            ];
            this.txFramePos = 1;
            return this._scramble(0);
          }
          return this._scramble(1);
        }
        // Ensure txSyms covers through ABSOLUTE symbol index k (txSyms[0] == symbol
        // this.txSymBase). Only the continuous data flow generates via the bit path;
        // the finite pre-roll bursts pre-fill txSyms directly.
        _ensureSymbols(k) {
          if (!this.txContinuous) return;
          while (this.txSymBase + this.txSyms.length <= k) {
            const Q1 = this._txBit(), Q2 = this._txBit(), Q3 = this._txBit(), Q4 = this._txBit();
            const Qval = Q2 << 1 | Q1;
            this.txPrevY = this.txPrevY + Qval & 3;
            const base = BASE[Q3 << 1 | Q4];
            this.txSyms.push(rotCCW(base.i, base.q, this.txPrevY));
          }
        }
        generateAudio(count) {
          const out = new Float32Array(count);
          if (this.txState !== "active") {
            this._maybeStartBurst();
            if (this.txState !== "active") {
              this._idleSamples += count;
              return out;
            }
          }
          if (this.txMode === "tone") {
            for (let c = 0; c < count; c++) {
              const n = this.txN++;
              if (this.txEndSample >= 0 && n >= this.txEndSample) {
                this.txState = "idle";
                this._resetTxBurst();
                break;
              }
              out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * n / SR) * ANS_TONE_AMP;
            }
            return out;
          }
          for (let c = 0; c < count; c++) {
            const n = this.txN++;
            if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
              this.txState = "idle";
              this._resetTxBurst();
              break;
            }
            const st = n / SPS;
            const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
            this._ensureSymbols(khi);
            let ai = 0, aq = 0;
            for (let k = Math.max(klo, this.txSymBase); k <= khi; k++) {
              const s = this.txSyms[k - this.txSymBase];
              if (!s) break;
              const p = rrc(st - k);
              ai += s.i * p;
              aq += s.q * p;
            }
            const ph = 2 * Math.PI * FC * n / SR;
            out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * TX_GAIN;
          }
          if (this.txContinuous) {
            const oldest = Math.floor(this.txN / SPS - SPAN) - 1;
            const drop = oldest - this.txSymBase;
            if (drop > 512) {
              this.txSyms.splice(0, drop);
              this.txSymBase += drop;
            }
          }
          return out;
        }
        // ─── RX ────────────────────────────────────────────────────────────────────
        _resetRx() {
          this.rx = [];
          this.rxBase = 0;
          this.acq = false;
          this.base = 0;
          this.symIdx = 0;
          this.des = new Array(23).fill(0);
          this.gr = 1;
          this.gi = 0;
          this.g2 = 1;
          this.rxPrevY = 0;
          this.outbits = [];
          this.uState = "hunt";
          this.uArmed = false;
          this.uMarks = 0;
          this.uBit = 0;
          this.uByte = 0;
          this._rxData = false;
          this._cState = "idle";
          this._cHi = 0;
        }
        _bb(n) {
          const ph = 2 * Math.PI * FC * n / SR;
          const s = this.rx[n - this.rxBase];
          return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2];
        }
        _sym(pos) {
          const end = this.rxBase + this.rx.length - 1;
          const nlo = Math.max(this.rxBase, Math.ceil(pos - SPAN / 2 * SPS));
          const nhi = Math.min(end, Math.floor(pos + SPAN / 2 * SPS));
          let ai = 0, aq = 0;
          for (let n = nlo; n <= nhi; n++) {
            const b = this._bb(n);
            const p = rrc((n - pos) / SPS);
            ai += b[0] * p;
            aq += b[1] * p;
          }
          return [ai, aq];
        }
        receiveAudio(f32) {
          for (let i = 0; i < f32.length; i++) {
            const s = f32[i];
            this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
            if (this.rxLevel > RX_HI) {
              this.rxOn = true;
              this.rxLow = 0;
            } else if (this.rxLevel < RX_LO && this.rxOn) {
              this.rxLow++;
            }
            if (this.rxOn) this.rx.push(s);
            if (this.rxOn && this.rxLow > RX_HANG) {
              this._process();
              this.rxOn = false;
              if (!this.acq) this._resetRx();
              else this._resetRx();
            }
          }
          if (this.rxOn) this._process();
        }
        _process() {
          if (!this.acq) {
            if (this.rx.length < ACQ_MIN) return;
            let onset = -1, e = 0;
            for (let n = 0; n < this.rx.length; n++) {
              const b = this._bb(n);
              const m = Math.hypot(b[0], b[1]);
              e = 0.85 * e + 0.15 * m;
              if (e > 0.04) {
                onset = Math.max(0, n - 4);
                break;
              }
            }
            if (onset < 0) return;
            let best = onset, bestScore = -1;
            for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 16) {
              let sc = 0;
              for (let k = 0; k < 12; k++) {
                const s = this._sym(bo + k * SPS);
                sc += Math.hypot(s[0], s[1]);
              }
              if (sc > bestScore) {
                bestScore = sc;
                best = bo;
              }
            }
            const nSy = PRE + 8, ang = [], mag = [], sIQ = [];
            for (let j = 0; j < nSy; j++) {
              const s = this._sym(best + j * SPS);
              ang.push(Math.atan2(s[1], s[0]));
              mag.push(Math.hypot(s[0], s[1]));
              sIQ.push(s);
            }
            const dphi = [];
            for (let j = 1; j < nSy; j++) {
              let d = ang[j] - ang[j - 1];
              while (d > Math.PI) d -= 2 * Math.PI;
              while (d < -Math.PI) d += 2 * Math.PI;
              dphi.push(Math.abs(d));
            }
            let jB = -1;
            for (let j = 3; j < dphi.length - 4; j++) {
              const preAlt = dphi[j - 1] > 2 && dphi[j - 2] > 2;
              const nowConst = dphi[j] < 0.6 && dphi[j + 1] < 0.6 && dphi[j + 2] < 0.6;
              if (preAlt && nowConst) {
                jB = j;
                break;
              }
            }
            if (jB < 0) return;
            let mI = 0, mQ = 0, cnt = 0;
            for (let j = jB + 1; j < jB + SEG_B - 1 && j < nSy; j++) {
              mI += sIQ[j][0];
              mQ += sIQ[j][1];
              cnt++;
            }
            mI /= Math.max(1, cnt);
            mQ /= Math.max(1, cnt);
            this.gr = (mI * REF.i + mQ * REF.q) / 18;
            this.gi = (mQ * REF.i - mI * REF.q) / 18;
            this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
            this.base = best;
            this.symIdx = jB + SEG_B;
            this.rxPrevY = 0;
            this.acq = true;
            if (!this._ready) {
              this._ready = true;
              this.emit("ready", { bps: 9600, remoteDetected: true });
            }
          }
          while (true) {
            const pos = this.base + this.symIdx * SPS;
            const end = this.rxBase + this.rx.length - 1;
            if (pos + SPAN / 2 * SPS >= end) break;
            const s = this._sym(pos);
            const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
            const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
            const gi = level(xI), gq = level(xQ);
            const Y = quadOf(gi, gq);
            const b = rotCW(gi, gq, Y);
            const Q3 = Math.abs(b.i) === 3 ? 1 : 0, Q4 = Math.abs(b.q) === 3 ? 1 : 0;
            const Qval = Y - this.rxPrevY & 3;
            this.rxPrevY = Y;
            const Q1 = Qval & 1, Q2 = Qval >> 1 & 1;
            const bits = [Q1, Q2, Q3, Q4];
            for (const bit of bits) {
              const r = this.des;
              const ob = bit ^ r[this._rxTap] ^ r[22];
              r.unshift(bit);
              r.pop();
              this.outbits.push(ob);
            }
            this.symIdx++;
            this._uartConsume();
            const drop = Math.floor(this.base + (this.symIdx - SPAN) * SPS) - this.rxBase;
            if (drop > 512) {
              this.rx.splice(0, drop);
              this.rxBase += drop;
            }
          }
        }
        // Async start/stop deframer over the descrambled bit stream.
        _uartConsume() {
          while (this.outbits.length) {
            const bit = this.outbits.shift();
            if (this.uState === "hunt") {
              if (bit === 1) {
                if (!this.uArmed && this.uMarks < 255 && ++this.uMarks >= UART_ARM_MARKS) this.uArmed = true;
              } else if (this.uArmed) {
                this.uState = "data";
                this.uBit = 0;
                this.uByte = 0;
              }
            } else if (this.uState === "data") {
              this.uByte |= bit << this.uBit;
              this.uBit++;
              if (this.uBit === 8) this.uState = "stop";
            } else {
              if (bit === 1) {
                this._rxByte(this.uByte & 255);
                this.uState = "hunt";
              } else {
                this.uState = "hunt";
                this.uArmed = false;
                this.uMarks = 0;
              }
            }
          }
        }
        // One deframed byte: strip the leading R1/R2/R3 rate signals, then pass user
        // data up. The rate signals never reach the terminal.
        _rxByte(b) {
          if (this._rxData) {
            this.emit("data", Buffer.from([b]));
            return;
          }
          switch (this._cState) {
            case "idle":
              if (b === DLE) this._cState = "esc";
              break;
            case "esc":
              if (b === CTL_RATE) this._cState = "r1";
              else if (b === CTL_DATA) {
                this._rxData = true;
                this._cState = "idle";
              } else this._cState = "idle";
              break;
            case "r1":
              this._cHi = b;
              this._cState = "r2";
              break;
            case "r2":
              this.peerRate = (this._cHi << 8 | b) * 100;
              this._cState = "idle";
              break;
          }
        }
      };
      module.exports = { V32 };
    }
  });

  // vendor/src/dsp/protocols/V32bis.js
  var require_V32bis = __commonJS({
    "vendor/src/dsp/protocols/V32bis.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var SR = 8e3;
      var BAUD = 2400;
      var FC = 1800;
      var SPS = SR / BAUD;
      var ROLLOFF = 0.25;
      var SPAN = 10;
      var LEVELS = [-11, -9, -7, -5, -3, -1, 1, 3, 5, 7, 9, 11];
      var C128 = [];
      for (const q of LEVELS) for (const i of LEVELS) {
        if (Math.abs(i) >= 9 && Math.abs(q) >= 9) continue;
        C128.push({ i, q });
      }
      function sliceOdd(v) {
        let r = Math.round((v - 1) / 2) * 2 + 1;
        return r > 11 ? 11 : r < -11 ? -11 : r;
      }
      function slicePoint(xI, xQ) {
        let i = sliceOdd(xI), q = sliceOdd(xQ);
        if (Math.abs(i) >= 9 && Math.abs(q) >= 9) {
          const a = { i: Math.sign(i) * 7, q }, b = { i, q: Math.sign(q) * 7 };
          const da = (xI - a.i) ** 2 + (xQ - a.q) ** 2, db = (xI - b.i) ** 2 + (xQ - b.q) ** 2;
          return da < db ? a : b;
        }
        return { i, q };
      }
      var IDX = /* @__PURE__ */ new Map();
      for (let k = 0; k < C128.length; k++) IDX.set(C128[k].i * 100 + C128[k].q, k);
      var TAB1 = [
        [0, 1, 2, 3],
        // Q1Q2 = 00
        [1, 0, 3, 2],
        // Q1Q2 = 01
        [2, 3, 1, 0],
        // Q1Q2 = 10
        [3, 2, 0, 1]
        // Q1Q2 = 11
      ];
      var INV1 = [[], [], [], []];
      for (let din = 0; din < 4; din++) for (let yp = 0; yp < 4; yp++) INV1[yp][TAB1[din][yp]] = din;
      function convEncode(st, Y1, Y2) {
        const Y0 = st.c;
        const na = Y1 ^ st.c;
        const nb = st.a;
        const nc = st.b ^ Y1 & Y2;
        st.a = na;
        st.b = nb;
        st.c = nc;
        return Y0;
      }
      function rrcAt(t) {
        const b = ROLLOFF;
        if (Math.abs(t) < 1e-8) return 1 - b + 4 * b / Math.PI;
        if (Math.abs(Math.abs(4 * b * t) - 1) < 1e-6) {
          return b / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * b)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * b)));
        }
        const pt = Math.PI * t;
        return (Math.sin(pt * (1 - b)) + 4 * b * t * Math.cos(pt * (1 + b))) / (pt * (1 - 4 * b * t * (4 * b * t)));
      }
      var RRC_G = 1;
      {
        let s = 0;
        for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2;
        RRC_G = 1 / Math.sqrt(s / 4);
      }
      var rrc = (t) => rrcAt(t) * RRC_G;
      var TX_GAIN = 0.016;
      var REF = { i: 7, q: 7 };
      var SEG_A = 48;
      var SEG_B = 24;
      var PRE = SEG_A + SEG_B;
      var WARMUP_BITS = 48;
      var UART_ARM_MARKS = 8;
      var RX_A = 0.02;
      var RX_HI = 0.015;
      var RX_LO = 6e-3;
      var RX_HANG = 48;
      var ACQ_MIN = Math.ceil((PRE + 10) * SPS);
      var RATE_B = { 4800: 1 << 5, 9600: 1 << 6, 7200: 1 << 9, 12e3: 1 << 10, 14400: 1 << 12 };
      var RATE_WORD = (
        // B4,B7,B8,B11,B15 sync/framing + all rate bits
        1 << 4 | 1 << 7 | 1 << 8 | 1 << 11 | 1 << 15 | RATE_B[4800] | RATE_B[9600] | RATE_B[7200] | RATE_B[12e3] | RATE_B[14400]
      );
      function rateFromWord(w) {
        if (w & RATE_B[14400]) return 14400;
        if (w & RATE_B[12e3]) return 12e3;
        if (w & RATE_B[9600]) return 9600;
        if (w & RATE_B[7200]) return 7200;
        if (w & RATE_B[4800]) return 4800;
        return 0;
      }
      var DLE = 16;
      var CTL_RATE = 82;
      var CTL_DATA = 68;
      var RATE_FRAME = [DLE, CTL_RATE, RATE_WORD >> 8 & 255, RATE_WORD & 255];
      var DATA_MARK = [DLE, CTL_DATA];
      var RATE_REPEATS = 3;
      var ANS_TONE_FREQ = 2100;
      var ANS_TONE_AMP = 0.15;
      var ANS_TONE_SAMPLES = Math.round(1 * SR);
      var AATRAIN_SEG1 = Math.round(0.05 * BAUD);
      var AATRAIN_ALT = Math.round(0.2 * BAUD);
      var CONNECT_GAP = Math.round(0.08 * SR);
      var ORIG_LEAD = Math.round(0.6 * SR);
      var V32bis = class extends EventEmitter {
        constructor(role) {
          super();
          this.role = role === "originate" ? "originate" : "answer";
          this._ready = false;
          if (this.role === "originate") {
            this._txTap = 17;
            this._rxTap = 4;
          } else {
            this._txTap = 4;
            this._rxTap = 17;
          }
          this._rate = 14400;
          this.txByteQ = [];
          this.txCtrlQ = [];
          this.scr = new Array(23).fill(0);
          this.txState = "idle";
          this.txMode = "qam";
          this._connectQ = this._buildConnectScript(this.role);
          this._idleSamples = 0;
          this._resetTxBurst();
          this.rxLevel = 0;
          this.rxOn = false;
          this.rxLow = 0;
          this.peerRate = 0;
          this._resetRx();
        }
        get carrierDetected() {
          return this.rxOn || this.acq;
        }
        get bps() {
          return this._rate;
        }
        write(bytes) {
          for (const by of bytes) this.txByteQ.push(by & 255);
        }
        _scramble(bit) {
          const r = this.scr;
          const out = bit ^ r[this._txTap] ^ r[22];
          r.unshift(out);
          r.pop();
          return out;
        }
        // ─── TX ────────────────────────────────────────────────────────────────────
        _resetTxBurst() {
          this.txSyms = [];
          this.txSymBase = 0;
          this.txMode = "qam";
          this.txN = 0;
          this.txPrevY = 0;
          this.txConv = { a: 0, b: 0, c: 0 };
          this.txFrame = null;
          this.txFramePos = 0;
          this.txWarmup = 0;
          this.txEndSample = -1;
          this.txContinuous = false;
        }
        _buildPreamble() {
          for (let k = 0; k < SEG_A; k++) this.txSyms.push(k & 1 ? { i: -7, q: -7 } : { i: 7, q: 7 });
          for (let k = 0; k < SEG_B; k++) this.txSyms.push({ i: 7, q: 7 });
        }
        _buildConnectScript(role) {
          if (role === "answer") {
            return [
              { kind: "tone", gap: 0 },
              { kind: "train", gap: CONNECT_GAP },
              { kind: "data", gap: CONNECT_GAP }
            ];
          }
          return [
            { kind: "train", gap: ORIG_LEAD },
            { kind: "data", gap: CONNECT_GAP }
          ];
        }
        _buildAATrain() {
          for (let k = 0; k < AATRAIN_SEG1; k++) this.txSyms.push({ i: 7, q: 7 });
          for (let k = 0; k < AATRAIN_ALT; k++) this.txSyms.push(k & 1 ? { i: -7, q: -7 } : { i: 7, q: 7 });
        }
        _startBurst(kind) {
          this._resetTxBurst();
          this.scr.fill(0);
          if (kind === "tone") {
            this.txMode = "tone";
            this.txEndSample = ANS_TONE_SAMPLES;
            this.txState = "active";
            this._idleSamples = 0;
            return;
          }
          if (kind === "train") {
            this._buildAATrain();
            this.txEndSample = Math.ceil((this.txSyms.length + SPAN / 2) * SPS);
            this.txState = "active";
            this._idleSamples = 0;
            return;
          }
          this._buildPreamble();
          this.txPrevY = 0;
          this.txConv = { a: 0, b: 0, c: 0 };
          this.txWarmup = WARMUP_BITS;
          this.txContinuous = true;
          this.txCtrlQ = [];
          for (let r = 0; r < RATE_REPEATS; r++) this.txCtrlQ.push(...RATE_FRAME);
          this.txCtrlQ.push(...DATA_MARK);
          this.txState = "active";
          this._idleSamples = 0;
        }
        _maybeStartBurst() {
          if (this._connectQ.length) {
            if (this._idleSamples < this._connectQ[0].gap) return;
            this._startBurst(this._connectQ.shift().kind);
          }
        }
        _txBit() {
          if (this.txWarmup > 0) {
            this.txWarmup--;
            return this._scramble(1);
          }
          if (this.txFrame) {
            const b = this.txFrame[this.txFramePos++];
            if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
            return this._scramble(b);
          }
          let by = null;
          if (this.txCtrlQ.length) by = this.txCtrlQ.shift();
          else if (this.txByteQ.length) by = this.txByteQ.shift();
          if (by !== null) {
            this.txFrame = [
              0,
              by & 1,
              by >> 1 & 1,
              by >> 2 & 1,
              by >> 3 & 1,
              by >> 4 & 1,
              by >> 5 & 1,
              by >> 6 & 1,
              by >> 7 & 1,
              1
            ];
            this.txFramePos = 1;
            return this._scramble(0);
          }
          return this._scramble(1);
        }
        // Generate one data symbol point from six scrambled bits.
        _dataSymbol() {
          const Q1 = this._txBit(), Q2 = this._txBit(), Q3 = this._txBit(), Q4 = this._txBit(), Q5 = this._txBit(), Q6 = this._txBit();
          const din = Q1 << 1 | Q2;
          this.txPrevY = TAB1[din][this.txPrevY];
          const Y1 = this.txPrevY >> 1 & 1, Y2 = this.txPrevY & 1;
          const Y0 = convEncode(this.txConv, Y1, Y2);
          const idx = Y0 << 6 | Y1 << 5 | Y2 << 4 | Q3 << 3 | Q4 << 2 | Q5 << 1 | Q6;
          return C128[idx];
        }
        _ensureSymbols(k) {
          if (!this.txContinuous) return;
          while (this.txSymBase + this.txSyms.length <= k) this.txSyms.push(this._dataSymbol());
        }
        generateAudio(count) {
          const out = new Float32Array(count);
          if (this.txState !== "active") {
            this._maybeStartBurst();
            if (this.txState !== "active") {
              this._idleSamples += count;
              return out;
            }
          }
          if (this.txMode === "tone") {
            for (let c = 0; c < count; c++) {
              const n = this.txN++;
              if (this.txEndSample >= 0 && n >= this.txEndSample) {
                this.txState = "idle";
                this._resetTxBurst();
                break;
              }
              out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * n / SR) * ANS_TONE_AMP;
            }
            return out;
          }
          for (let c = 0; c < count; c++) {
            const n = this.txN++;
            if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
              this.txState = "idle";
              this._resetTxBurst();
              break;
            }
            const st = n / SPS;
            const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
            this._ensureSymbols(khi);
            let ai = 0, aq = 0;
            for (let k = Math.max(klo, this.txSymBase); k <= khi; k++) {
              const s = this.txSyms[k - this.txSymBase];
              if (!s) break;
              const p = rrc(st - k);
              ai += s.i * p;
              aq += s.q * p;
            }
            const ph = 2 * Math.PI * FC * n / SR;
            out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * TX_GAIN;
          }
          if (this.txContinuous) {
            const oldest = Math.floor(this.txN / SPS - SPAN) - 1;
            const drop = oldest - this.txSymBase;
            if (drop > 512) {
              this.txSyms.splice(0, drop);
              this.txSymBase += drop;
            }
          }
          return out;
        }
        // ─── RX ────────────────────────────────────────────────────────────────────
        _resetRx() {
          this.rx = [];
          this.rxBase = 0;
          this.acq = false;
          this.base = 0;
          this.symIdx = 0;
          this.des = new Array(23).fill(0);
          this.gr = 1;
          this.gi = 0;
          this.g2 = 1;
          this.rxPrevY = 0;
          this.outbits = [];
          this.uState = "hunt";
          this.uArmed = false;
          this.uMarks = 0;
          this.uBit = 0;
          this.uByte = 0;
          this._rxData = false;
          this._cState = "idle";
          this._cHi = 0;
        }
        _bb(n) {
          const ph = 2 * Math.PI * FC * n / SR;
          const s = this.rx[n - this.rxBase];
          return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2];
        }
        _sym(pos) {
          const end = this.rxBase + this.rx.length - 1;
          const nlo = Math.max(this.rxBase, Math.ceil(pos - SPAN / 2 * SPS));
          const nhi = Math.min(end, Math.floor(pos + SPAN / 2 * SPS));
          let ai = 0, aq = 0;
          for (let n = nlo; n <= nhi; n++) {
            const b = this._bb(n);
            const p = rrc((n - pos) / SPS);
            ai += b[0] * p;
            aq += b[1] * p;
          }
          return [ai, aq];
        }
        receiveAudio(f32) {
          for (let i = 0; i < f32.length; i++) {
            const s = f32[i];
            this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
            if (this.rxLevel > RX_HI) {
              this.rxOn = true;
              this.rxLow = 0;
            } else if (this.rxLevel < RX_LO && this.rxOn) {
              this.rxLow++;
            }
            if (this.rxOn) this.rx.push(s);
            if (this.rxOn && this.rxLow > RX_HANG) {
              this._process();
              this.rxOn = false;
              this._resetRx();
            }
          }
          if (this.rxOn) this._process();
        }
        _process() {
          if (!this.acq) {
            if (this.rx.length < ACQ_MIN) return;
            let onset = -1, e = 0;
            for (let n = 0; n < this.rx.length; n++) {
              const b = this._bb(n);
              const m = Math.hypot(b[0], b[1]);
              e = 0.85 * e + 0.15 * m;
              if (e > 0.04) {
                onset = Math.max(0, n - 4);
                break;
              }
            }
            if (onset < 0) return;
            let best = onset, bestScore = -1;
            for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 16) {
              let sc = 0;
              for (let k = 0; k < 12; k++) {
                const s = this._sym(bo + k * SPS);
                sc += Math.hypot(s[0], s[1]);
              }
              if (sc > bestScore) {
                bestScore = sc;
                best = bo;
              }
            }
            const nSy = PRE + 8, ang = [], mag = [], sIQ = [];
            for (let j = 0; j < nSy; j++) {
              const s = this._sym(best + j * SPS);
              ang.push(Math.atan2(s[1], s[0]));
              mag.push(Math.hypot(s[0], s[1]));
              sIQ.push(s);
            }
            const dphi = [];
            for (let j = 1; j < nSy; j++) {
              let d = ang[j] - ang[j - 1];
              while (d > Math.PI) d -= 2 * Math.PI;
              while (d < -Math.PI) d += 2 * Math.PI;
              dphi.push(Math.abs(d));
            }
            let jB = -1;
            for (let j = 3; j < dphi.length - 4; j++) {
              const preAlt = dphi[j - 1] > 2 && dphi[j - 2] > 2;
              const nowConst = dphi[j] < 0.6 && dphi[j + 1] < 0.6 && dphi[j + 2] < 0.6;
              if (preAlt && nowConst) {
                jB = j;
                break;
              }
            }
            if (jB < 0) return;
            let mI = 0, mQ = 0, cnt = 0;
            for (let j = jB + 1; j < jB + SEG_B - 1 && j < nSy; j++) {
              mI += sIQ[j][0];
              mQ += sIQ[j][1];
              cnt++;
            }
            mI /= Math.max(1, cnt);
            mQ /= Math.max(1, cnt);
            const R2 = REF.i * REF.i + REF.q * REF.q;
            this.gr = (mI * REF.i + mQ * REF.q) / R2;
            this.gi = (mQ * REF.i - mI * REF.q) / R2;
            this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
            this.base = best;
            this.symIdx = jB + SEG_B;
            this.rxPrevY = 0;
            this.acq = true;
            if (!this._ready) {
              this._ready = true;
              this.emit("ready", { bps: this._rate, remoteDetected: true });
            }
          }
          while (true) {
            const pos = this.base + this.symIdx * SPS;
            const end = this.rxBase + this.rx.length - 1;
            if (pos + SPAN / 2 * SPS >= end) break;
            const s = this._sym(pos);
            const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
            const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
            const p = slicePoint(xI, xQ);
            const idx = IDX.get(p.i * 100 + p.q);
            if (idx === void 0) {
              this.symIdx++;
              continue;
            }
            const Y1 = idx >> 5 & 1, Y2 = idx >> 4 & 1;
            const Q3 = idx >> 3 & 1, Q4 = idx >> 2 & 1, Q5 = idx >> 1 & 1, Q6 = idx & 1;
            const yNew = Y1 << 1 | Y2;
            const din = INV1[this.rxPrevY][yNew];
            this.rxPrevY = yNew;
            const Q1 = din >> 1 & 1, Q2 = din & 1;
            const bits = [Q1, Q2, Q3, Q4, Q5, Q6];
            for (const bit of bits) {
              const r = this.des;
              const ob = bit ^ r[this._rxTap] ^ r[22];
              r.unshift(bit);
              r.pop();
              this.outbits.push(ob);
            }
            this.symIdx++;
            this._uartConsume();
            const drop = Math.floor(this.base + (this.symIdx - SPAN) * SPS) - this.rxBase;
            if (drop > 512) {
              this.rx.splice(0, drop);
              this.rxBase += drop;
            }
          }
        }
        _uartConsume() {
          while (this.outbits.length) {
            const bit = this.outbits.shift();
            if (this.uState === "hunt") {
              if (bit === 1) {
                if (!this.uArmed && this.uMarks < 255 && ++this.uMarks >= UART_ARM_MARKS) this.uArmed = true;
              } else if (this.uArmed) {
                this.uState = "data";
                this.uBit = 0;
                this.uByte = 0;
              }
            } else if (this.uState === "data") {
              this.uByte |= bit << this.uBit;
              this.uBit++;
              if (this.uBit === 8) this.uState = "stop";
            } else {
              if (bit === 1) {
                this._rxByte(this.uByte & 255);
                this.uState = "hunt";
              } else {
                this.uState = "hunt";
                this.uArmed = false;
                this.uMarks = 0;
              }
            }
          }
        }
        _rxByte(b) {
          if (this._rxData) {
            this.emit("data", Buffer.from([b]));
            return;
          }
          switch (this._cState) {
            case "idle":
              if (b === DLE) this._cState = "esc";
              break;
            case "esc":
              if (b === CTL_RATE) this._cState = "r1";
              else if (b === CTL_DATA) {
                this._rxData = true;
                this._cState = "idle";
              } else this._cState = "idle";
              break;
            case "r1":
              this._cHi = b;
              this._cState = "r2";
              break;
            case "r2": {
              const word = this._cHi << 8 | b;
              this.peerRate = rateFromWord(word);
              this._rate = Math.min(this._rate, this.peerRate) || this._rate;
              this._cState = "idle";
              break;
            }
          }
        }
      };
      module.exports = { V32bis };
    }
  });

  // vendor/src/dsp/protocols/V34Mapper.js
  var require_V34Mapper = __commonJS({
    "vendor/src/dsp/protocols/V34Mapper.js"(exports, module) {
      "use strict";
      var SYMS_PER_FRAME = 8;
      function sliceOdd(v) {
        return Math.round((v - 1) / 2) * 2 + 1;
      }
      function rotCW(p, rot) {
        let i = p.i, q = p.q;
        for (let r = 0; r < (rot & 3); r++) {
          const ni = q, nq = -i;
          i = ni;
          q = nq;
        }
        return { i, q };
      }
      function invRot(p) {
        const x = p.i, y = p.q;
        if (x > 0 && y > 0) return { rep: { i: x, q: y }, rot: 0 };
        if (x > 0 && y < 0) return { rep: { i: -y, q: x }, rot: 1 };
        if (x < 0 && y < 0) return { rep: { i: -x, q: -y }, rot: 2 };
        return { rep: { i: y, q: -x }, rot: 3 };
      }
      var FIG9 = [
        [0, 7, 4, 3],
        // Im=-3
        [5, 2, 1, 6],
        // Im=-1
        [4, 0, 3, 7],
        // Im=+1
        [1, 6, 5, 2]
        // Im=+3
      ];
      function subsetLabel(p) {
        const re = ((p.i + 3) / 2 % 4 + 4) % 4;
        const im = ((p.q + 3) / 2 % 4 + 4) % 4;
        return FIG9[im][re];
      }
      var TABLE13 = [
        [0, 0, 1, 1, 8, 8, 9, 9],
        [3, 2, 2, 3, 11, 10, 10, 11],
        [5, 5, 4, 4, 13, 13, 12, 12],
        [6, 7, 7, 6, 14, 15, 15, 14],
        [8, 8, 9, 9, 0, 0, 1, 1],
        [11, 10, 10, 11, 3, 2, 2, 3],
        [13, 13, 12, 12, 5, 5, 4, 4],
        [14, 15, 15, 14, 6, 7, 7, 6]
      ];
      function conv16Next(state, Y1, Y2) {
        const Y0 = state & 1;
        const ns = state ^ (Y1 << 1 | Y2 << 2 | (Y2 ^ Y0) << 3 | Y0 << 4);
        return ns >> 1;
      }
      function makeConfig({ sRate, bitRate, frameBits, kShell, mRings, swp = 65535 }) {
        const qBits = ((frameBits - kShell) / 4 - 3) / 2;
        if (!Number.isInteger(qBits) || qBits < 0) throw new Error("bad V.34 config: q not integer");
        const switching = (swp & 65535) !== 65535;
        const isHighFrame = (idx) => switching ? (swp >>> (idx % 16 + 16) % 16 & 1) === 1 : true;
        const ringSize = 1 << qBits;
        const quarterPts = ringSize * mRings;
        const reps = [];
        const R = 81;
        for (let b = 1; b <= R; b += 2) for (let a = 1; a <= R; a += 2) reps.push({ i: a, q: b });
        reps.sort((p1, p2) => {
          const e1 = p1.i * p1.i + p1.q * p1.q, e2 = p2.i * p2.i + p2.q * p2.q;
          if (e1 !== e2) return e1 - e2;
          if (p1.q !== p2.q) return p2.q - p1.q;
          return p1.i - p2.i;
        });
        const quarter = reps.slice(0, quarterPts);
        const labelMap = /* @__PURE__ */ new Map();
        for (let k = 0; k < quarter.length; k++) labelMap.set(quarter[k].i * 1e4 + quarter[k].q, k);
        const labelOf = (rep) => {
          const v = labelMap.get(rep.i * 1e4 + rep.q);
          return v === void 0 ? -1 : v;
        };
        const n = 8 * (mRings - 1) + 1, M = mRings;
        const g2 = new Array(n).fill(0);
        for (let p = 0; p < n; p++) g2[p] = p <= 2 * (M - 1) ? M - Math.abs(p - (M - 1)) : 0;
        const g4 = new Array(n).fill(0);
        for (let p = 0; p < n; p++) {
          let s = 0;
          if (p <= 4 * (M - 1)) for (let i = 0; i <= p; i++) s += g2[i] * g2[p - i];
          g4[p] = s;
        }
        const g8 = new Array(n).fill(0);
        for (let p = 0; p < n; p++) {
          let s = 0;
          if (p <= 8 * (M - 1)) for (let i = 0; i <= p; i++) s += g4[i] * g4[p - i];
          g8[p] = s;
        }
        const z8 = new Array(n + 1).fill(0);
        for (let p = 1; p <= n; p++) z8[p] = z8[p - 1] + (g8[p - 1] || 0);
        function indexToRings(R0) {
          let A = 0;
          while (z8[A + 1] !== void 0 && z8[A + 1] <= R0) A++;
          let B = 0, R1;
          for (; ; ) {
            let s = 0;
            for (let p = 0; p < B + 1; p++) s += g4[p] * g4[A - p];
            if (R0 - z8[A] - s < 0) break;
            B++;
          }
          {
            let s = 0;
            for (let p = 0; p < B; p++) s += g4[p] * g4[A - p];
            R1 = R0 - z8[A] - s;
          }
          const R2 = R1 % g4[B], R3 = (R1 - R2) / g4[B];
          let C = 0;
          for (; ; ) {
            let s = 0;
            for (let p = 0; p < C + 1; p++) s += g2[p] * g2[B - p];
            if (R2 - s < 0) break;
            C++;
          }
          let R4;
          {
            let s = 0;
            for (let p = 0; p < C; p++) s += g2[p] * g2[B - p];
            R4 = R2 - s;
          }
          let D = 0;
          for (; ; ) {
            let s = 0;
            for (let p = 0; p < D + 1; p++) s += g2[p] * g2[A - B - p];
            if (R3 - s < 0) break;
            D++;
          }
          let R5;
          {
            let s = 0;
            for (let p = 0; p < D; p++) s += g2[p] * g2[A - B - p];
            R5 = R3 - s;
          }
          const E = R4 % g2[C], F = (R4 - E) / g2[C], G = R5 % g2[D], H = (R5 - G) / g2[D];
          const m = [[0, 0], [0, 0], [0, 0], [0, 0]];
          if (C < M) {
            m[0][0] = E;
            m[0][1] = C - E;
          } else {
            m[0][1] = M - 1 - E;
            m[0][0] = C - m[0][1];
          }
          if (B - C < M) {
            m[1][0] = F;
            m[1][1] = B - C - F;
          } else {
            m[1][1] = M - 1 - F;
            m[1][0] = B - C - m[1][1];
          }
          if (D < M) {
            m[2][0] = G;
            m[2][1] = D - G;
          } else {
            m[2][1] = M - 1 - G;
            m[2][0] = D - m[2][1];
          }
          if (A - B - D < M) {
            m[3][0] = H;
            m[3][1] = A - B - D - H;
          } else {
            m[3][1] = M - 1 - H;
            m[3][0] = A - B - D - m[3][1];
          }
          return m;
        }
        function ringsToIndex(m) {
          const C = m[0][0] + m[0][1], E = C < M ? m[0][0] : M - 1 - m[0][1];
          const BmC = m[1][0] + m[1][1], F = BmC < M ? m[1][0] : M - 1 - m[1][1], B = C + BmC;
          const D = m[2][0] + m[2][1], G = D < M ? m[2][0] : M - 1 - m[2][1];
          const AmBmD = m[3][0] + m[3][1], H = AmBmD < M ? m[3][0] : M - 1 - m[3][1], A = B + D + AmBmD;
          const R4 = F * g2[C] + E, R5 = H * g2[D] + G;
          let s2 = 0;
          for (let p = 0; p < C; p++) s2 += g2[p] * g2[B - p];
          const R2 = R4 + s2;
          let s3 = 0;
          for (let p = 0; p < D; p++) s3 += g2[p] * g2[A - B - p];
          const R3 = R5 + s3;
          const R1 = R3 * g4[B] + R2;
          let s1 = 0;
          for (let p = 0; p < B; p++) s1 += g4[p] * g4[A - p];
          return R1 + z8[A] + s1;
        }
        const groupBits = 3 + 2 * qBits;
        return {
          sRate,
          bitRate,
          frameBits,
          kShell,
          mRings,
          qBits,
          ringSize,
          quarterPts,
          symsPerFrame: SYMS_PER_FRAME,
          quarter,
          labelOf,
          pointForLabel: (label) => quarter[label],
          indexToRings,
          ringsToIndex,
          swp,
          switching,
          groupBits,
          frameBitsHigh: frameBits,
          frameBitsLow: frameBits - 1,
          isHighFrame,
          // data-stream bits drawn for the mapping frame at index idx
          bitsForFrame: (idx) => isHighFrame(idx) ? frameBits : frameBits - 1
        };
      }
      var CONFIGS = {
        "19200/2400": { sRate: 2400, bitRate: 19200, frameBits: 64, kShell: 28, mRings: 12 },
        "28800/3200": { sRate: 3200, bitRate: 28800, frameBits: 72, kShell: 28, mRings: 12 },
        // 31200/3200: near drop-in on the proven 3200 front-end — larger 1280-pt
        // constellation, still constant-b (all-high SWP), no frame switching.
        "31200/3200": { sRate: 3200, bitRate: 31200, frameBits: 78, kShell: 26, mRings: 10 },
        // 33600/3429: the top V.34 rate. Needs the 3429 front-end (2.33 SPS, 1959 Hz)
        // AND §8.2 frame switching (SWP=14A5 ⇒ mixed b/b−1 frames). b here is the HIGH
        // frame bit count (79); low frames carry 78 via the §9.3.1 forced-0 shell bit.
        "33600/3429": { sRate: 3429, bitRate: 33600, frameBits: 79, kShell: 27, mRings: 11, swp: 5285 }
      };
      var V34Coder = class {
        constructor(cfg) {
          this.cfg = cfg;
          this.reset();
        }
        reset() {
          this.zPrev = 0;
          this.conv = 0;
          this.rxZPrev = 0;
        }
        // high=true → b data bits (K shell bits); high=false → b−1 data bits, with a
        // forced 0 inserted as the top shell bit (§9.3.1) so the shell mapper still sees
        // K bits. `bits` therefore has length bitsForFrame(idx): K+4·groupBits (high) or
        // (K−1)+4·groupBits (low). The I/Q parser and constellation are identical.
        encodeFrame(bits, high = true) {
          const cfg = this.cfg, K = cfg.kShell, q = cfg.qBits, RS = cfg.ringSize;
          const kReal = high ? K : K - 1;
          let R0 = 0;
          for (let i = 0; i < kReal; i++) if (bits[i]) R0 += 2 ** i;
          const rings = cfg.indexToRings(R0);
          const pts = [];
          let bp = kReal;
          for (let j = 0; j < 4; j++) {
            const I1 = bits[bp++], I2 = bits[bp++], I3 = bits[bp++];
            const Qk = [0, 0];
            for (let k = 0; k < 2; k++) {
              let v = 0;
              for (let t = 0; t < q; t++) v |= bits[bp++] << t;
              Qk[k] = v;
            }
            const I = I2 + 2 * I3;
            const Z = I + this.zPrev & 3;
            const U0 = this.conv & 1;
            const u0 = rotCW(cfg.pointForLabel(Qk[0] + RS * rings[j][0]), Z);
            const u1 = rotCW(cfg.pointForLabel(Qk[1] + RS * rings[j][1]), Z + 2 * I1 + U0 & 3);
            const y = TABLE13[subsetLabel(u0)][subsetLabel(u1)];
            this.conv = conv16Next(this.conv, y & 1, y >> 1 & 1);
            this.zPrev = Z;
            pts.push(u0, u1);
          }
          return pts;
        }
        decodeFrame(pts, high = true) {
          const cfg = this.cfg, K = cfg.kShell, q = cfg.qBits, RS = cfg.ringSize;
          const kReal = high ? K : K - 1;
          const bits = new Array(kReal + 4 * cfg.groupBits).fill(0);
          const rings = [[0, 0], [0, 0], [0, 0], [0, 0]];
          let bp = kReal;
          for (let j = 0; j < 4; j++) {
            const a = invRot(pts[2 * j]), b = invRot(pts[2 * j + 1]);
            const label0 = cfg.labelOf(a.rep), label1 = cfg.labelOf(b.rep);
            rings[j][0] = label0 >> q;
            rings[j][1] = label1 >> q;
            const Q0 = label0 & RS - 1, Q1 = label1 & RS - 1;
            const Z = a.rot;
            const I = Z - this.rxZPrev & 3;
            const value = b.rot - a.rot & 3;
            const I1 = value >> 1;
            const I2 = I & 1, I3 = I >> 1 & 1;
            this.rxZPrev = Z;
            bits[bp++] = I1;
            bits[bp++] = I2;
            bits[bp++] = I3;
            for (let t = 0; t < q; t++) bits[bp++] = Q0 >> t & 1;
            for (let t = 0; t < q; t++) bits[bp++] = Q1 >> t & 1;
          }
          const R0 = cfg.ringsToIndex(rings);
          for (let i = 0; i < kReal; i++) bits[i] = Math.floor(R0 / 2 ** i) & 1;
          return bits;
        }
      };
      module.exports = { V34Coder, makeConfig, CONFIGS, SYMS_PER_FRAME, sliceOdd, invRot };
    }
  });

  // vendor/src/dsp/protocols/V34.js
  var require_V34 = __commonJS({
    "vendor/src/dsp/protocols/V34.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var { V34Coder, makeConfig, CONFIGS, sliceOdd, invRot } = require_V34Mapper();
      var config = require_config();
      var RF = {
        2400: { fc: 1800, rolloff: 0.25, span: 10 },
        3200: { fc: 1920, rolloff: 0.2, span: 24 },
        3429: { fc: 1959, rolloff: 0.14, span: 32 }
      };
      var AMP = {
        "19200/2400": { meanE: 214, ref: { i: 9, q: 9 } },
        "28800/3200": { meanE: 427, ref: { i: 15, q: 15 } },
        "31200/3200": { meanE: 725, ref: { i: 19, q: 19 } },
        "33600/3429": { meanE: 725, ref: { i: 19, q: 19 } }
      };
      var RATE_ALIASES = { 19200: "19200/2400", 28800: "28800/3200", 31200: "31200/3200", 33600: "33600/3429" };
      var DEFAULT_RATE = "33600/3429";
      function resolveRateName() {
        const sel = config.modem && config.modem.native && config.modem.native.v34Rate;
        if (typeof sel === "string" && CONFIGS[sel]) return sel;
        if (typeof sel === "number" && RATE_ALIASES[sel]) return RATE_ALIASES[sel];
        if (typeof sel === "string" && RATE_ALIASES[+sel]) return RATE_ALIASES[+sel];
        return DEFAULT_RATE;
      }
      var SR = 8e3;
      var SYMS_PER_FRAME = 8;
      var SEG_A = 48;
      var SEG_B = 24;
      var PRE = SEG_A + SEG_B;
      var WARMUP_BITS = 48;
      var UART_ARM_MARKS = 8;
      var RX_A = 0.02;
      var RX_HI = 0.015;
      var RX_LO = 6e-3;
      var RX_HANG = 48;
      var DLE = 16;
      var CTL_RATE = 82;
      var CTL_DATA = 68;
      var DATA_MARK = [DLE, CTL_DATA];
      var RATE_REPEATS = 3;
      var ANS_TONE_FREQ = 2100;
      var ANS_TONE_AMP = 0.15;
      var ANS_TONE_SAMPLES = Math.round(1 * SR);
      var CONNECT_GAP = Math.round(0.08 * SR);
      var ORIG_LEAD = Math.round(0.6 * SR);
      var CURRENT_RATE = null;
      var CFG;
      var FE;
      var labelOf;
      var BAUD;
      var FC;
      var SPS;
      var ROLLOFF;
      var SPAN;
      var RRC_G = 1;
      var MEAN_E;
      var TX_GAIN;
      var REF;
      var ACQ_MIN;
      var RATE_BPS;
      var RATE_FRAME;
      var AATRAIN_SEG1;
      var AATRAIN_ALT;
      function rrcAt(t) {
        const b = ROLLOFF;
        if (Math.abs(t) < 1e-8) return 1 - b + 4 * b / Math.PI;
        if (Math.abs(Math.abs(4 * b * t) - 1) < 1e-6) {
          return b / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * b)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * b)));
        }
        const pt = Math.PI * t;
        return (Math.sin(pt * (1 - b)) + 4 * b * t * Math.cos(pt * (1 + b))) / (pt * (1 - 4 * b * t * (4 * b * t)));
      }
      var rrc = (t) => rrcAt(t) * RRC_G;
      function configure(rateName) {
        if (rateName === CURRENT_RATE) return;
        CFG = makeConfig(CONFIGS[rateName]);
        FE = RF[CFG.sRate];
        const amp = AMP[rateName];
        labelOf = CFG.labelOf;
        BAUD = CFG.sRate;
        FC = FE.fc;
        SPS = SR / BAUD;
        ROLLOFF = FE.rolloff;
        SPAN = FE.span;
        {
          let s = 0;
          for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2;
          RRC_G = 1 / Math.sqrt(s / 4);
        }
        MEAN_E = amp.meanE;
        TX_GAIN = 0.1 / Math.sqrt(MEAN_E) * Math.SQRT2 * 0.999;
        REF = amp.ref;
        ACQ_MIN = Math.ceil((PRE + 10) * SPS);
        RATE_BPS = CFG.bitRate;
        RATE_FRAME = [DLE, CTL_RATE, RATE_BPS >> 8 & 255, RATE_BPS & 255];
        AATRAIN_SEG1 = Math.round(0.05 * BAUD);
        AATRAIN_ALT = Math.round(0.2 * BAUD);
        CURRENT_RATE = rateName;
      }
      configure(DEFAULT_RATE);
      var V34 = class extends EventEmitter {
        constructor(role) {
          super();
          configure(resolveRateName());
          this.role = role === "originate" ? "originate" : "answer";
          this._ready = false;
          if (this.role === "originate") {
            this._txTap = 17;
            this._rxTap = 4;
          } else {
            this._txTap = 4;
            this._rxTap = 17;
          }
          this._rate = RATE_BPS;
          this.txByteQ = [];
          this.txCtrlQ = [];
          this.scr = new Array(23).fill(0);
          this.txCoder = new V34Coder(CFG);
          this.txState = "idle";
          this.txMode = "qam";
          this._connectQ = this._buildConnectScript(this.role);
          this._idleSamples = 0;
          this._resetTxBurst();
          this.rxLevel = 0;
          this.rxOn = false;
          this.rxLow = 0;
          this.peerRate = 0;
          this.rxCoder = new V34Coder(CFG);
          this._resetRx();
        }
        get carrierDetected() {
          return this.rxOn || this.acq;
        }
        get bps() {
          return this._rate;
        }
        write(bytes) {
          for (const by of bytes) this.txByteQ.push(by & 255);
        }
        _scramble(bit) {
          const r = this.scr;
          const out = bit ^ r[this._txTap] ^ r[22];
          r.unshift(out);
          r.pop();
          return out;
        }
        // ─── TX ────────────────────────────────────────────────────────────────────
        _resetTxBurst() {
          this.txSyms = [];
          this.txSymBase = 0;
          this.txMode = "qam";
          this.txN = 0;
          this.txFrame = null;
          this.txFramePos = 0;
          this.txWarmup = 0;
          this.txEndSample = -1;
          this.txContinuous = false;
          this.txFrameIdx = 0;
        }
        _buildPreamble() {
          for (let k = 0; k < SEG_A; k++) this.txSyms.push(k & 1 ? { i: -REF.i, q: -REF.q } : { i: REF.i, q: REF.q });
          for (let k = 0; k < SEG_B; k++) this.txSyms.push({ i: REF.i, q: REF.q });
        }
        _buildConnectScript(role) {
          if (role === "answer") {
            return [
              { kind: "tone", gap: 0 },
              { kind: "train", gap: CONNECT_GAP },
              { kind: "data", gap: CONNECT_GAP }
            ];
          }
          return [
            { kind: "train", gap: ORIG_LEAD },
            { kind: "data", gap: CONNECT_GAP }
          ];
        }
        _buildAATrain() {
          for (let k = 0; k < AATRAIN_SEG1; k++) this.txSyms.push({ i: REF.i, q: REF.q });
          for (let k = 0; k < AATRAIN_ALT; k++) this.txSyms.push(k & 1 ? { i: -REF.i, q: -REF.q } : { i: REF.i, q: REF.q });
        }
        _startBurst(kind) {
          this._resetTxBurst();
          this.scr.fill(0);
          this.txCoder.reset();
          if (kind === "tone") {
            this.txMode = "tone";
            this.txEndSample = ANS_TONE_SAMPLES;
            this.txState = "active";
            this._idleSamples = 0;
            return;
          }
          if (kind === "train") {
            this._buildAATrain();
            this.txEndSample = Math.ceil((this.txSyms.length + SPAN / 2) * SPS);
            this.txState = "active";
            this._idleSamples = 0;
            return;
          }
          this._buildPreamble();
          this.txWarmup = WARMUP_BITS;
          this.txContinuous = true;
          this.txCtrlQ = [];
          for (let r = 0; r < RATE_REPEATS; r++) this.txCtrlQ.push(...RATE_FRAME);
          this.txCtrlQ.push(...DATA_MARK);
          this.txState = "active";
          this._idleSamples = 0;
        }
        _maybeStartBurst() {
          if (this._connectQ.length) {
            if (this._idleSamples < this._connectQ[0].gap) return;
            this._startBurst(this._connectQ.shift().kind);
          }
        }
        _txBit() {
          if (this.txWarmup > 0) {
            this.txWarmup--;
            return this._scramble(1);
          }
          if (this.txFrame) {
            const b = this.txFrame[this.txFramePos++];
            if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
            return this._scramble(b);
          }
          let by = null;
          if (this.txCtrlQ.length) by = this.txCtrlQ.shift();
          else if (this.txByteQ.length) by = this.txByteQ.shift();
          if (by !== null) {
            this.txFrame = [
              0,
              by & 1,
              by >> 1 & 1,
              by >> 2 & 1,
              by >> 3 & 1,
              by >> 4 & 1,
              by >> 5 & 1,
              by >> 6 & 1,
              by >> 7 & 1,
              1
            ];
            this.txFramePos = 1;
            return this._scramble(0);
          }
          return this._scramble(1);
        }
        // Encode one mapping frame: this frame's parity (high/low, §8.2) comes from the
        // SWP-driven frame counter; pull the matching bit count (b or b−1) of scrambled
        // bits, run the genuine V.34 chain (shell map + differential + trellis + mapper)
        // → SYMS_PER_FRAME points. For the all-high configs this is always b bits.
        _encodeFrameSymbols() {
          const idx = this.txFrameIdx++;
          const high = CFG.isHighFrame(idx);
          const nb = high ? CFG.frameBitsHigh : CFG.frameBitsLow;
          const bits = new Array(nb);
          for (let i = 0; i < nb; i++) bits[i] = this._txBit();
          return this.txCoder.encodeFrame(bits, high);
        }
        _ensureSymbols(k) {
          if (!this.txContinuous) return;
          while (this.txSymBase + this.txSyms.length <= k) {
            const pts = this._encodeFrameSymbols();
            for (const p of pts) this.txSyms.push(p);
          }
        }
        generateAudio(count) {
          const out = new Float32Array(count);
          if (this.txState !== "active") {
            this._maybeStartBurst();
            if (this.txState !== "active") {
              this._idleSamples += count;
              return out;
            }
          }
          if (this.txMode === "tone") {
            for (let c = 0; c < count; c++) {
              const n = this.txN++;
              if (this.txEndSample >= 0 && n >= this.txEndSample) {
                this.txState = "idle";
                this._resetTxBurst();
                break;
              }
              out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * n / SR) * ANS_TONE_AMP;
            }
            return out;
          }
          for (let c = 0; c < count; c++) {
            const n = this.txN++;
            if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
              this.txState = "idle";
              this._resetTxBurst();
              break;
            }
            const st = n / SPS;
            const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
            this._ensureSymbols(khi);
            let ai = 0, aq = 0;
            for (let k = Math.max(klo, this.txSymBase); k <= khi; k++) {
              const s = this.txSyms[k - this.txSymBase];
              if (!s) break;
              const p = rrc(st - k);
              ai += s.i * p;
              aq += s.q * p;
            }
            const ph = 2 * Math.PI * FC * n / SR;
            out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * TX_GAIN;
          }
          if (this.txContinuous) {
            const oldest = Math.floor(this.txN / SPS - SPAN) - 1;
            const drop = oldest - this.txSymBase;
            if (drop > 512) {
              this.txSyms.splice(0, drop);
              this.txSymBase += drop;
            }
          }
          return out;
        }
        // ─── RX ────────────────────────────────────────────────────────────────────
        _resetRx() {
          this.rx = [];
          this.rxBase = 0;
          this.acq = false;
          this.base = 0;
          this.symIdx = 0;
          this.des = new Array(23).fill(0);
          this.gr = 1;
          this.gi = 0;
          this.g2 = 1;
          this.outbits = [];
          this.rxPts = [];
          this.rxFrameIdx = 0;
          this.rxCoder.reset();
          this.uState = "hunt";
          this.uArmed = false;
          this.uMarks = 0;
          this.uBit = 0;
          this.uByte = 0;
          this._rxData = false;
          this._cState = "idle";
          this._cHi = 0;
        }
        _bb(n) {
          const ph = 2 * Math.PI * FC * n / SR;
          const s = this.rx[n - this.rxBase];
          return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2];
        }
        _sym(pos) {
          const end = this.rxBase + this.rx.length - 1;
          const nlo = Math.max(this.rxBase, Math.ceil(pos - SPAN / 2 * SPS));
          const nhi = Math.min(end, Math.floor(pos + SPAN / 2 * SPS));
          let ai = 0, aq = 0;
          for (let n = nlo; n <= nhi; n++) {
            const b = this._bb(n);
            const p = rrc((n - pos) / SPS);
            ai += b[0] * p;
            aq += b[1] * p;
          }
          return [ai, aq];
        }
        receiveAudio(f32) {
          for (let i = 0; i < f32.length; i++) {
            const s = f32[i];
            this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
            if (this.rxLevel > RX_HI) {
              this.rxOn = true;
              this.rxLow = 0;
            } else if (this.rxLevel < RX_LO && this.rxOn) {
              this.rxLow++;
            }
            if (this.rxOn) this.rx.push(s);
            if (this.rxOn && this.rxLow > RX_HANG) {
              this._process();
              this.rxOn = false;
              this._resetRx();
            }
          }
          if (this.rxOn) this._process();
        }
        _process() {
          if (!this.acq) {
            if (this.rx.length < ACQ_MIN) return;
            let onset = -1, e = 0;
            for (let n = 0; n < this.rx.length; n++) {
              const b = this._bb(n);
              const m = Math.hypot(b[0], b[1]);
              e = 0.85 * e + 0.15 * m;
              if (e > 0.04) {
                onset = Math.max(0, n - 4);
                break;
              }
            }
            if (onset < 0) return;
            let best = onset, bestScore = -1;
            for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
              let sc = 0;
              for (let k = 0; k < 12; k++) {
                const s = this._sym(bo + k * SPS);
                sc += Math.hypot(s[0], s[1]);
              }
              if (sc > bestScore) {
                bestScore = sc;
                best = bo;
              }
            }
            const nSy = PRE + 8, ang = [], mag = [], sIQ = [];
            for (let j = 0; j < nSy; j++) {
              const s = this._sym(best + j * SPS);
              ang.push(Math.atan2(s[1], s[0]));
              mag.push(Math.hypot(s[0], s[1]));
              sIQ.push(s);
            }
            const dphi = [];
            for (let j = 1; j < nSy; j++) {
              let d = ang[j] - ang[j - 1];
              while (d > Math.PI) d -= 2 * Math.PI;
              while (d < -Math.PI) d += 2 * Math.PI;
              dphi.push(Math.abs(d));
            }
            let jB = -1;
            for (let j = 3; j < dphi.length - 4; j++) {
              const preAlt = dphi[j - 1] > 2 && dphi[j - 2] > 2;
              const nowConst = dphi[j] < 0.6 && dphi[j + 1] < 0.6 && dphi[j + 2] < 0.6;
              if (preAlt && nowConst) {
                jB = j;
                break;
              }
            }
            if (jB < 0) return;
            let mI = 0, mQ = 0, cnt = 0;
            for (let j = jB + 1; j < jB + SEG_B - 1 && j < nSy; j++) {
              mI += sIQ[j][0];
              mQ += sIQ[j][1];
              cnt++;
            }
            mI /= Math.max(1, cnt);
            mQ /= Math.max(1, cnt);
            const R2 = REF.i * REF.i + REF.q * REF.q;
            this.gr = (mI * REF.i + mQ * REF.q) / R2;
            this.gi = (mQ * REF.i - mI * REF.q) / R2;
            this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
            this.base = best;
            this.symIdx = jB + SEG_B;
            this.acq = true;
            if (!this._ready) {
              this._ready = true;
              this.emit("ready", { bps: this._rate, remoteDetected: true });
            }
          }
          while (true) {
            const pos = this.base + this.symIdx * SPS;
            const end = this.rxBase + this.rx.length - 1;
            if (pos + SPAN / 2 * SPS >= end) break;
            const s = this._sym(pos);
            const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
            const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
            const pt = { i: sliceOdd(xI), q: sliceOdd(xQ) };
            this.symIdx++;
            if (labelOf(invRot(pt).rep) < 0) {
              this.rxPts = [];
              continue;
            }
            this.rxPts.push(pt);
            if (this.rxPts.length === SYMS_PER_FRAME) {
              const high = CFG.isHighFrame(this.rxFrameIdx++);
              const fbits = this.rxCoder.decodeFrame(this.rxPts, high);
              this.rxPts = [];
              for (let b = 0; b < fbits.length; b++) {
                const bit = fbits[b];
                const r = this.des;
                const ob = bit ^ r[this._rxTap] ^ r[22];
                r.unshift(bit);
                r.pop();
                this.outbits.push(ob);
              }
              this._uartConsume();
            }
            const drop = Math.floor(this.base + (this.symIdx - SPAN) * SPS) - this.rxBase;
            if (drop > 512) {
              this.rx.splice(0, drop);
              this.rxBase += drop;
            }
          }
        }
        _uartConsume() {
          while (this.outbits.length) {
            const bit = this.outbits.shift();
            if (this.uState === "hunt") {
              if (bit === 1) {
                if (!this.uArmed && this.uMarks < 255 && ++this.uMarks >= UART_ARM_MARKS) this.uArmed = true;
              } else if (this.uArmed) {
                this.uState = "data";
                this.uBit = 0;
                this.uByte = 0;
              }
            } else if (this.uState === "data") {
              this.uByte |= bit << this.uBit;
              this.uBit++;
              if (this.uBit === 8) this.uState = "stop";
            } else {
              if (bit === 1) {
                this._rxByte(this.uByte & 255);
                this.uState = "hunt";
              } else {
                this.uState = "hunt";
                this.uArmed = false;
                this.uMarks = 0;
              }
            }
          }
        }
        _rxByte(b) {
          if (this._rxData) {
            this.emit("data", Buffer.from([b]));
            return;
          }
          switch (this._cState) {
            case "idle":
              if (b === DLE) this._cState = "esc";
              break;
            case "esc":
              if (b === CTL_RATE) this._cState = "r1";
              else if (b === CTL_DATA) {
                this._rxData = true;
                this._cState = "idle";
              } else this._cState = "idle";
              break;
            case "r1":
              this._cHi = b;
              this._cState = "r2";
              break;
            case "r2": {
              this.peerRate = this._cHi << 8 | b;
              this._rate = Math.min(this._rate, this.peerRate) || this._rate;
              this._cState = "idle";
              break;
            }
          }
        }
      };
      module.exports = { V34 };
    }
  });

  // vendor/src/dsp/Handshake.js
  var require_Handshake = __commonJS({
    "vendor/src/dsp/Handshake.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var config = require_config();
      var { makeLogger } = require_logger();
      var { generateTone } = require_Primitives();
      var V8 = require_V8();
      var { V8Sequencer } = require_V8Sequencer();
      var { V21 } = require_V21();
      var { Bell103 } = require_Bell103();
      var { V22, V22bis } = require_V22();
      var { V23 } = require_V23();
      var { V29 } = require_V29();
      var { V32 } = require_V32();
      var { V32bis } = require_V32bis();
      var { V34 } = require_V34();
      var log = makeLogger("Handshake");
      var SR = config.rtp.sampleRate;
      var cfg = config.modem.native;
      var PROTOCOLS = {
        V21: (role) => new V21(role),
        Bell103: (role) => new Bell103(role),
        V22: (role) => new V22(role),
        V22bis: (role) => new V22bis(role),
        V23: (role) => new V23(role),
        V29: (role) => new V29(role),
        V32: (role) => new V32(role),
        V32bis: (role) => new V32bis(role),
        V34: (role) => new V34(role)
      };
      var ANS_FREQ = 2100;
      var TE_MS = 1e3;
      var HS_STATE = {
        IDLE: "IDLE",
        ANS_SEND: "ANS_SEND",
        // Forced-protocol path: emitting plain ANS
        V8_NEGOTIATE: "V8_NEGOTIATE",
        // Delegating audio TX/RX to V8Sequencer
        TRAINING: "TRAINING",
        // Protocol-specific training
        DATA: "DATA",
        FAILED: "FAILED"
      };
      var FskDiscriminator = class {
        constructor(inBandHz, crossBandHz) {
          this._inHz = inBandHz;
          this._crossHz = crossBandHz;
          this._inE = 0;
          this._crossE = 0;
          this._alpha = 0.2;
        }
        process(samples) {
          const n = samples.length;
          const kIn = 2 * Math.PI * this._inHz / SR;
          const kCross = 2 * Math.PI * this._crossHz / SR;
          const cIn = 2 * Math.cos(kIn);
          const cCross = 2 * Math.cos(kCross);
          let s1i = 0, s2i = 0, s1c = 0, s2c = 0;
          for (let i = 0; i < n; i++) {
            const x = samples[i];
            let nw = x + cIn * s1i - s2i;
            s2i = s1i;
            s1i = nw;
            nw = x + cCross * s1c - s2c;
            s2c = s1c;
            s1c = nw;
          }
          const magIn = Math.sqrt(s1i * s1i + s2i * s2i - cIn * s1i * s2i) / n;
          const magCross = Math.sqrt(s1c * s1c + s2c * s2c - cCross * s1c * s2c) / n;
          this._inE = this._inE * (1 - this._alpha) + magIn * this._alpha;
          this._crossE = this._crossE * (1 - this._alpha) + magCross * this._alpha;
        }
        /** True if in-band energy dominates cross-band energy. */
        isInBand() {
          return this._inE > 1.5 * this._crossE + 1e-3;
        }
        /** Diagnostic. */
        get inE() {
          return this._inE;
        }
        get crossE() {
          return this._crossE;
        }
      };
      var HandshakeEngine = class extends EventEmitter {
        constructor(role) {
          super();
          this._role = role;
          this._state = HS_STATE.IDLE;
          this._protocol = null;
          this._protocolName = null;
          this._audioQueue = [];
          this._timer = null;
          this._forced = cfg.forceProtocol;
          this._pendingForcedProtocol = null;
          this._v8seq = null;
          if (cfg.advertiseProtocol && this._role === "originate") {
            this._advertise = [cfg.advertiseProtocol];
          }
        }
        // ─── Start / stop ────────────────────────────────────────────────────────
        /**
         * Start the handshake.
         *
         * @param {object} [opts]
         * @param {boolean} [opts.skipV8=false] — Skip V.8 entirely; jump straight
         *     to the V.25 legacy automode probe chain. Implies skipAnsam=true
         *     because by definition the caller has already heard ANSam from
         *     elsewhere (the `auto` backend uses this after slmodemd-pjsip
         *     played 12 s of ANSam and timed out waiting for CM).
         * @param {boolean} [opts.skipAnsam=false] — Skip the ANSam phase even
         *     in V.8 mode. Currently only meaningful in conjunction with
         *     skipV8.
         *
         * Default behaviour (no opts) is unchanged: forced-protocol path,
         * else V.8 negotiation, else V.25 fallback.
         */
        start(opts) {
          opts = opts || {};
          this._state = HS_STATE.IDLE;
          log.info(`Handshake starting (${this._role})${opts.skipV8 ? " [skipV8]" : ""}${opts.skipAnsam ? " [skipAnsam]" : ""}`);
          if (opts.skipV8) {
            log.info("Skipping V.8 / ANSam \u2014 entering V.25 legacy automode probe directly");
            this._probeQueue = [
              { protocol: "V22bis", listenMs: 5e3 },
              { protocol: "V21", listenMs: 3e3 },
              { protocol: "Bell103", listenMs: 5e3 }
            ];
            this._advanceProbe();
            return;
          }
          const wantV29 = this._forced === "V29" || cfg.v8ModulationModes && cfg.v8ModulationModes[0] === "V29" || cfg.protocolPreference && cfg.protocolPreference[0] === "V29";
          if (wantV29) {
            log.info("V.29 selected \u2014 bypassing V.8 / ANS, starting symmetric preamble");
            this._selectProtocol("V29");
            return;
          }
          const wantV32 = this._forced === "V32" || cfg.v8ModulationModes && cfg.v8ModulationModes[0] === "V32" || cfg.protocolPreference && cfg.protocolPreference[0] === "V32";
          if (wantV32) {
            log.info("V.32 selected \u2014 bypassing V.8 / ANS, starting full-duplex training");
            this._selectProtocol("V32");
            return;
          }
          const wantV32bis = this._forced === "V32bis" || cfg.v8ModulationModes && cfg.v8ModulationModes[0] === "V32bis" || cfg.protocolPreference && cfg.protocolPreference[0] === "V32bis";
          if (wantV32bis) {
            log.info("V.32bis selected \u2014 bypassing V.8 / ANS, starting full-duplex training");
            this._selectProtocol("V32bis");
            return;
          }
          const wantV34 = this._forced === "V34" || cfg.v8ModulationModes && cfg.v8ModulationModes[0] === "V34" || cfg.protocolPreference && cfg.protocolPreference[0] === "V34";
          if (wantV34) {
            log.info("V.34 selected \u2014 bypassing V.8 / ANS, starting full-duplex training");
            this._selectProtocol("V34");
            return;
          }
          if (this._forced) {
            log.info(`Protocol forced to ${this._forced} \u2014 bypassing V.8`);
            if (this._role === "answer") {
              const initialDelay = Math.max(cfg.answerToneDelayMs || 0, 1800);
              const teMs = this._forced === "V22" || this._forced === "V22bis" ? 150 : TE_MS;
              log.info(`Initial silence (${initialDelay} ms) + plain ANS (${cfg.answerToneDurationMs} ms) + Te silence (${teMs} ms) before ${this._forced} training`);
              this._enqueueSilence(initialDelay);
              this._enqueue(generateTone(ANS_FREQ, cfg.answerToneDurationMs, SR, 0.15));
              this._enqueueSilence(teMs);
              this._state = HS_STATE.ANS_SEND;
              this._pendingForcedProtocol = this._forced;
            } else {
              this._selectProtocol(this._forced);
            }
            return;
          }
          if (this._role === "answer" && cfg.answerToneDelayMs > 0) {
            this._enqueueSilence(cfg.answerToneDelayMs);
          }
          this._startV8();
        }
        /** Construct the V8Sequencer, wire its events, and start it. */
        _startV8() {
          const advertised = this._advertise || cfg.v8ModulationModes || cfg.protocolPreference;
          log.debug(`V.8 enabled \u2014 starting sequencer (advertising ${advertised.join(",")})`);
          this._state = HS_STATE.V8_NEGOTIATE;
          this._v8seq = new V8Sequencer({
            role: this._role,
            parms: {
              modulations: advertised,
              callFn: 6
              // V_SERIES — modem data
            }
          });
          this._v8seq.on("result", (result) => {
            log.info(`V.8 negotiation complete \u2014 selected ${result.protocol}`);
            this._v8seq = null;
            this._selectProtocol(result.protocol);
          });
          this._v8seq.on("failed", (reason) => {
            this._v8seq = null;
            if (reason === "timeout-no-cm" || reason === "timeout-no-ansam") {
              log.info(`V.8 timed out (${reason}) \u2014 entering V.25 legacy automode probe`);
              this._probeQueue = [
                { protocol: "V22bis", listenMs: 5e3 },
                { protocol: "V21", listenMs: 3e3 },
                { protocol: "Bell103", listenMs: 5e3 }
              ];
              this._advanceProbe();
            } else {
              const fallback = cfg.protocolPreference[cfg.protocolPreference.length - 1];
              log.warn(`V.8 handshake failed (${reason}) \u2014 falling back to ${fallback}`);
              this._selectProtocol(fallback);
            }
          });
          this._v8seq.on("non-v8", () => {
            this._v8seq = null;
            const fallback = cfg.protocolPreference[cfg.protocolPreference.length - 1];
            log.info(`V.8: peer not V.8-capable \u2014 falling back to ${fallback}`);
            this._selectProtocol(fallback);
          });
          this._v8seq.start();
        }
        stop() {
          if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
          }
          if (this._cdPollTimer) {
            clearInterval(this._cdPollTimer);
            this._cdPollTimer = null;
          }
          this._pendingForcedProtocol = null;
          this._state = HS_STATE.IDLE;
          if (this._protocol) {
            this._protocol.removeAllListeners();
            this._protocol = null;
          }
          if (this._v8seq) {
            this._v8seq.stop();
            this._v8seq.removeAllListeners();
            this._v8seq = null;
          }
        }
        // ─── Audio generation ────────────────────────────────────────────────────
        generateAudio(n) {
          if (this._state === HS_STATE.DATA && this._protocol) {
            return this._protocol.generateAudio(n);
          }
          if (this._state === HS_STATE.V8_NEGOTIATE && this._v8seq) {
            const queued = this._drainQueue(n);
            let hasNonSilence = false;
            for (let i = 0; i < queued.length; i++) {
              if (queued[i] !== 0) {
                hasNonSilence = true;
                break;
              }
            }
            if (hasNonSilence) return queued;
            return this._v8seq.generateAudio(n);
          }
          if (this._state === HS_STATE.ANS_SEND && this._pendingForcedProtocol) {
            const out = new Float32Array(n);
            let pos = 0;
            while (pos < n && this._audioQueue.length > 0) {
              const item = this._audioQueue[0];
              const avail = item.samples.length - item.pos;
              const take = Math.min(avail, n - pos);
              out.set(item.samples.subarray(item.pos, item.pos + take), pos);
              item.pos += take;
              pos += take;
              if (item.pos >= item.samples.length) this._audioQueue.shift();
            }
            if (pos < n) {
              const forced = this._pendingForcedProtocol;
              this._pendingForcedProtocol = null;
              this._selectProtocol(forced);
              if (this._protocol && this._protocol.generateAudio) {
                const remaining = n - pos;
                const live = this._protocol.generateAudio(remaining);
                out.set(live.subarray(0, remaining), pos);
              }
            }
            return out;
          }
          if (this._state === HS_STATE.TRAINING && this._protocol && this._protocol.generateAudio) {
            return this._drainQueueOrGenerate(n);
          }
          return this._drainQueue(n);
        }
        _drainQueueOrGenerate(n) {
          const out = new Float32Array(n);
          let pos = 0;
          while (pos < n && this._audioQueue.length > 0) {
            const item = this._audioQueue[0];
            const avail = item.samples.length - item.pos;
            const take = Math.min(avail, n - pos);
            out.set(item.samples.subarray(item.pos, item.pos + take), pos);
            item.pos += take;
            pos += take;
            if (item.pos >= item.samples.length) this._audioQueue.shift();
          }
          if (pos < n) {
            const remaining = n - pos;
            const live = this._protocol.generateAudio(remaining);
            out.set(live.subarray(0, remaining), pos);
          }
          return out;
        }
        _drainQueue(n) {
          const out = new Float32Array(n);
          let pos = 0;
          while (pos < n && this._audioQueue.length > 0) {
            const item = this._audioQueue[0];
            const avail = item.samples.length - item.pos;
            const take = Math.min(avail, n - pos);
            out.set(item.samples.subarray(item.pos, item.pos + take), pos);
            item.pos += take;
            pos += take;
            if (item.pos >= item.samples.length) this._audioQueue.shift();
          }
          return out;
        }
        _enqueue(samples) {
          this._audioQueue.push({ samples, pos: 0 });
        }
        _enqueueSilence(durationMs) {
          const n = Math.round(SR * durationMs / 1e3);
          this._enqueue(new Float32Array(n));
        }
        // ─── Receive audio ───────────────────────────────────────────────────────
        receiveAudio(samples) {
          if (this._state === HS_STATE.DATA && this._protocol) {
            this._protocol.receiveAudio(samples);
            return;
          }
          if (this._state === HS_STATE.TRAINING && this._protocol) {
            this._protocol.receiveAudio(samples);
            if (this._fskDiscriminator) this._fskDiscriminator.process(samples);
            return;
          }
          if (this._state === HS_STATE.V8_NEGOTIATE && this._v8seq) {
            this._v8seq.receiveAudio(samples);
          }
        }
        // ─── Protocol selection and training ────────────────────────────────────
        /**
         * Advance to the next probe in `_probeQueue`. Called when a probe times
         * out without producing a stable carrier. Each probe instantiates a
         * fresh protocol instance, transmits the answer-side training signal,
         * and listens for the configured window. If all probes fail, emits
         * `handshake-failed` with reason `all-probes-failed`.
         *
         * Per V.25 legacy automode (and the implementation tip from the other
         * AI consult): every probe transition fully tears down the previous
         * protocol instance before starting the next. Otherwise the previous
         * demodulator could keep firing carrier-detect events from the new
         * probe's TX signal leaking into its passband, producing false
         * positives that lock us onto the wrong protocol.
         */
        _advanceProbe() {
          if (this._protocol) {
            this._protocol.removeAllListeners();
            this._protocol = null;
            this._protocolName = null;
          }
          if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
          }
          if (this._cdPollTimer) {
            clearInterval(this._cdPollTimer);
            this._cdPollTimer = null;
          }
          this._fskDiscriminator = null;
          if (!this._probeQueue || this._probeQueue.length === 0) {
            log.warn("Legacy automode probe chain exhausted \u2014 no protocol matched");
            this._state = HS_STATE.FAILED;
            this.emit("handshake-failed", { protocol: null, reason: "all-probes-failed" });
            return;
          }
          const probe = this._probeQueue.shift();
          log.info(`Legacy probe: trying ${probe.protocol} (${probe.listenMs}ms listen window)`);
          this._selectProtocol(probe.protocol, probe.listenMs);
        }
        _selectProtocol(name, listenWindowMs) {
          log.info(`Selecting protocol: ${name}`);
          if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
          }
          this._protocolName = name;
          this._protocol = PROTOCOLS[name] ? PROTOCOLS[name](this._role) : PROTOCOLS["V21"](this._role);
          this._protocol.on("data", (buf) => this.emit("data", buf));
          this._state = HS_STATE.TRAINING;
          if (name === "V22bis" || name === "V22" || name === "V29" || name === "V32" || name === "V32bis" || name === "V34") {
            log.debug(`${name} start-up \u2014 waiting for sequencer ready`);
            if (this._protocol.on) {
              this._protocol.on("listening", () => {
                log.info(`${name} sequencer running \u2014 listening for remote carrier`);
              });
              this._protocol.on("remote-detected", (info) => {
                log.info(`${name} remote carrier detected (rx RMS=${info.rms.toFixed(3)})`);
              });
            }
            this._protocol.once("ready", (info) => {
              if (info.remoteDetected === false) {
                log.warn(`${name} handshake FAILED \u2014 no remote carrier detected during listen window`);
                this._handleProtocolFailure(name, "no-remote-carrier");
                return;
              }
              this._state = HS_STATE.DATA;
              const tag = info.remoteDetected === true ? " (remote detected)" : "";
              log.info(`Handshake complete \u2014 ${name} @ ${info.bps} bps${tag}`);
              this._probeQueue = null;
              this.emit("connected", {
                protocol: name,
                bps: info.bps,
                instance: this._protocol
              });
            });
            return;
          }
          const trainMs = cfg.trainingDurationMs[name] || 600;
          log.debug(`Training for ${trainMs}ms`);
          const trainSamples = Math.round(SR * trainMs / 1e3);
          if (trainSamples > 0) {
            const trainAudio = this._protocol.generateAudio ? this._protocol.generateAudio(trainSamples) : new Float32Array(trainSamples);
            this._enqueue(trainAudio);
          }
          this._fskDiscriminator = null;
          const isAnswerSideProbe = this._role === "answer" && (this._probeQueue !== null && this._probeQueue !== void 0);
          if (isAnswerSideProbe) {
            if (name === "V21") {
              this._fskDiscriminator = new FskDiscriminator(980, 1270);
            } else if (name === "Bell103") {
              this._fskDiscriminator = new FskDiscriminator(1270, 980);
            }
          }
          const trainEndMs = trainMs + 100;
          const finalListenWindowMs = listenWindowMs != null ? listenWindowMs : cfg.listenWindowMs != null ? cfg.listenWindowMs : 5e3;
          const cdStableMs = cfg.cdStableMs != null ? cfg.cdStableMs : 500;
          const pollIntervalMs = 50;
          this._timer = setTimeout(() => {
            const pollStart = Date.now();
            let cdStableStart = null;
            const hasCD = () => {
              if (this._protocol && typeof this._protocol.carrierDetected !== "undefined") {
                if (!this._protocol.carrierDetected) return false;
                if (this._fskDiscriminator && !this._fskDiscriminator.isInBand()) {
                  return false;
                }
                return true;
              }
              return null;
            };
            if (hasCD() === null || cfg.skipCdVerification) {
              this._state = HS_STATE.DATA;
              log.info(`Handshake complete \u2014 ${name} @ ${this._protocol.bps || "?"} bps (CD verification skipped)`);
              this._probeQueue = null;
              this.emit("connected", {
                protocol: name,
                bps: this._protocol.bps || 0,
                instance: this._protocol
              });
              return;
            }
            log.debug(`${name} TX training complete \u2014 waiting for stable remote carrier (\u2265${cdStableMs}ms CD within ${finalListenWindowMs}ms window)`);
            this._cdPollTimer = setInterval(() => {
              const now = Date.now();
              const cd = hasCD();
              if (cd === true) {
                if (cdStableStart === null) cdStableStart = now;
              } else {
                if (cdStableStart !== null) {
                  log.debug(`${name} CD dropped after ${now - cdStableStart}ms \u2014 restarting stability timer`);
                }
                cdStableStart = null;
              }
              const cdStableFor = cdStableStart !== null ? now - cdStableStart : 0;
              if (cdStableFor >= cdStableMs) {
                clearInterval(this._cdPollTimer);
                this._cdPollTimer = null;
                this._state = HS_STATE.DATA;
                log.info(`Handshake complete \u2014 ${name} @ ${this._protocol.bps || "?"} bps (CD stable for ${cdStableFor}ms)`);
                this._probeQueue = null;
                this.emit("connected", {
                  protocol: name,
                  bps: this._protocol.bps || 0,
                  instance: this._protocol
                });
                return;
              }
              if (now - pollStart >= finalListenWindowMs) {
                clearInterval(this._cdPollTimer);
                this._cdPollTimer = null;
                log.warn(`${name} handshake FAILED \u2014 no stable remote carrier within ${finalListenWindowMs}ms (CD last held ${cdStableFor}ms, need ${cdStableMs}ms)`);
                this._handleProtocolFailure(name, "no-stable-carrier");
              }
            }, pollIntervalMs);
          }, trainEndMs);
        }
        /**
         * A single probe (or forced protocol) failed to lock. If we are in the
         * middle of a legacy automode probe chain, advance to the next probe;
         * otherwise emit `handshake-failed` upward.
         */
        _handleProtocolFailure(protocolName, reason) {
          if (this._probeQueue && this._probeQueue.length > 0) {
            log.info(`${protocolName} probe failed (${reason}) \u2014 advancing to next probe`);
            this._advanceProbe();
            return;
          }
          if (this._probeQueue && this._probeQueue.length === 0) {
            log.warn(`${protocolName} probe failed (${reason}) \u2014 chain exhausted`);
            this._state = HS_STATE.FAILED;
            this.emit("handshake-failed", { protocol: protocolName, reason: "all-probes-failed" });
            return;
          }
          this._state = HS_STATE.IDLE;
          this.emit("handshake-failed", { protocol: protocolName, reason });
        }
        // ─── Data mode passthrough ──────────────────────────────────────────────
        write(data) {
          if (this._protocol) this._protocol.write(data);
        }
        get state() {
          return this._state;
        }
        get protocol() {
          return this._protocolName;
        }
        get isData() {
          return this._state === HS_STATE.DATA;
        }
      };
      module.exports = { HandshakeEngine, PROTOCOLS, FskDiscriminator };
    }
  });

  // vendor/src/dsp/ModemDSP.js
  var require_ModemDSP = __commonJS({
    "vendor/src/dsp/ModemDSP.js"(exports, module) {
      "use strict";
      var { EventEmitter } = require_events();
      var config = require_config();
      var { makeLogger } = require_logger();
      var { rms } = require_Primitives();
      var { HandshakeEngine } = require_Handshake();
      var log = makeLogger("ModemDSP");
      var cfg = config.modem;
      var ncfg = config.modem.native;
      var rcfg = config.rtp;
      var SR = rcfg.sampleRate;
      var BLOCK = rcfg.packetIntervalMs * SR / 1e3;
      var SAMPLES_PER_MS = SR / 1e3;
      var ModemDSP = class extends EventEmitter {
        constructor(role) {
          super();
          this._role = role || cfg.role;
          this._handshake = new HandshakeEngine(this._role);
          this._connected = false;
          this._silentPkts = 0;
          this._txTimer = null;
          this._started = false;
          this._rxBuf = [];
          this._txStartMs = 0;
          this._txSamplesEmitted = 0;
          this._handshake.on("connected", (info) => {
            this._connected = true;
            log.info(`Modem connected: ${info.protocol} @ ${info.bps} bps`);
            this.emit("connected", info);
          });
          this._handshake.on("data", (buf) => {
            if (config.logging.logModemData) {
              log.trace(`Modem data RX: ${buf.toString("hex")}`);
            }
            this.emit("data", buf);
          });
        }
        // ─── Start / stop ────────────────────────────────────────────────────────────
        /**
         * Start the modem DSP.
         *
         * @param {object} [opts] — passed through to HandshakeEngine.start.
         *     Notable fields:
         *       skipV8:    boolean — skip V.8/ANSam, jump to V.25 legacy probe
         *       skipAnsam: boolean — skip ANSam in V.8 mode (typically with skipV8)
         *     See HandshakeEngine.start for full documentation. Used by the
         *     `auto` backend in CallSession when falling through from a failed
         *     slmodemd-pjsip V.8 attempt.
         */
        start(opts) {
          if (this._started) return;
          this._started = true;
          log.debug(`ModemDSP starting (${this._role})${opts && opts.skipV8 ? " [skipV8]" : ""}`);
          this._handshake.start(opts);
          this._txStartMs = Date.now();
          this._txSamplesEmitted = 0;
          this._txTimer = setInterval(() => this._txTick(), 5);
        }
        stop() {
          this._started = false;
          if (this._txTimer) {
            clearInterval(this._txTimer);
            this._txTimer = null;
          }
          this._handshake.stop();
        }
        // ─── TX path ─────────────────────────────────────────────────────────────────
        _txTick() {
          const elapsedMs = Date.now() - this._txStartMs;
          const targetSamples = Math.floor(elapsedMs * SAMPLES_PER_MS);
          const deficit = targetSamples - this._txSamplesEmitted;
          if (deficit <= 0) return;
          let blocks = Math.min(3, Math.floor(deficit / BLOCK));
          if (blocks === 0 && this._txSamplesEmitted === 0) blocks = 1;
          for (let i = 0; i < blocks; i++) {
            const audio = this._handshake.generateAudio(BLOCK);
            this.emit("audioOut", audio);
            this._txSamplesEmitted += BLOCK;
          }
        }
        /**
         * Write data bytes to be transmitted.
         * Only valid after 'connected' event.
         */
        write(data) {
          if (!this._connected) {
            log.warn("write() called before modem connected \u2014 buffering not implemented");
            return;
          }
          if (config.logging.logModemData) {
            log.trace(`Modem data TX: ${data.toString("hex")}`);
          }
          this._handshake.write(data);
        }
        // ─── RX path ─────────────────────────────────────────────────────────────────
        /**
         * Feed received audio samples from RTP.
         * @param {Float32Array} samples
         */
        receiveAudio(samples) {
          if (!this._started) return;
          const level = rms(samples);
          if (level < ncfg.silenceThreshold) {
            this._silentPkts++;
            if (this._silentPkts >= ncfg.silenceHangupPackets) {
              log.warn(`${this._silentPkts} silent packets \u2014 emitting silence-hangup`);
              this.emit("silenceHangup");
              this._silentPkts = 0;
            }
          } else {
            this._silentPkts = 0;
          }
          this._handshake.receiveAudio(samples);
        }
        // ─── Status ───────────────────────────────────────────────────────────────────
        get connected() {
          return this._connected;
        }
        get handshakeState() {
          return this._handshake.state;
        }
        get protocol() {
          return this._handshake.protocol;
        }
      };
      module.exports = { ModemDSP };
    }
  });

  // src/browser-dsp-entry.js
  var require_browser_dsp_entry = __commonJS({
    "src/browser-dsp-entry.js"(exports, module) {
      var { Buffer: Buffer2 } = require_buffer();
      if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer2;
      var config = require_synthlink_config();
      var { ModemDSP } = require_ModemDSP();
      module.exports = { ModemDSP, Buffer: Buffer2, config };
    }
  });
  return require_browser_dsp_entry();
})();
/*! Bundled license information:

ieee754/index.js:
  (*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> *)

buffer/index.js:
  (*!
   * The buffer module from node.js, for the browser.
   *
   * @author   Feross Aboukhadijeh <https://feross.org>
   * @license  MIT
   *)
*/

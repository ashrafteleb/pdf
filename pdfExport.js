const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const winston = require('winston');
const compression = require('compression');
const puppeteer = require('puppeteer');
const zlib = require('zlib');
const fetch = require('node-fetch');
const crc = require('crc');

const MAX_AREA = 10000 * 10000;
const PNG_CHUNK_IDAT = 1229209940;
var DOMParser = require('xmldom').DOMParser;

const PORT = process.env.PORT || 8000

const app = express();

//Max request size is 10 MB
app.use(bodyParser.urlencoded({ extended: false, limit: '10mb'}));
app.use(bodyParser.json({ limit: '10mb' }));

app.use(compression({
    threshold: 10,
}));

//Enable request logging using morgan and Apache combined format
app.use(morgan('combined'));


const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    //
    // - Write to all logs with level `info` and below to `combined.log` 
    // - Write all logs error (and below) to `error.log`.
    //
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ],
  exceptionHandlers: [
    new winston.transports.File({ filename: 'exceptions.log' })
  ]
});

//If we're not in production then log to the `console` also
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}
  
// NOTE: Key length must not be longer than 79 bytes (not checked)
function writePngWithText(origBuff, key, text, compressed, base64encoded)
{
	var inOffset = 0;
	var outOffset = 0;
	var data = text;
	var dataLen = key.length + data.length + 1; //we add 1 zeros with non-compressed data
	
	//prepare compressed data to get its size
	if (compressed)
	{
		data = zlib.deflateRawSync(encodeURIComponent(text));
		dataLen = key.length + data.length + 2; //we add 2 zeros with compressed data
	}
	
	var outBuff = Buffer.allocUnsafe(origBuff.length + dataLen + 4); //4 is the header size "zTXt" or "tEXt"
	
	try
	{
		var magic1 = origBuff.readUInt32BE(inOffset);
		inOffset += 4;
		var magic2 = origBuff.readUInt32BE(inOffset);
		inOffset += 4;
		
		if (magic1 != 0x89504e47 && magic2 != 0x0d0a1a0a)
		{
			throw new Error("PNGImageDecoder0");
		}
		
		outBuff.writeUInt32BE(magic1, outOffset);
		outOffset += 4;
		outBuff.writeUInt32BE(magic2, outOffset);
		outOffset += 4;
	}
	catch (e)
	{
		logger.error(e.message, {stack: e.stack});
		throw new Error("PNGImageDecoder1");
	}

	try
	{
		while (inOffset < origBuff.length)
		{
			var length = origBuff.readInt32BE(inOffset);
			inOffset += 4;
			var type = origBuff.readInt32BE(inOffset)
			inOffset += 4;

			if (type == PNG_CHUNK_IDAT)
			{
				// Insert zTXt chunk before IDAT chunk
				outBuff.writeInt32BE(dataLen, outOffset);
				outOffset += 4;
				
				var typeSignature = (compressed) ? "zTXt" : "tEXt";
				outBuff.write(typeSignature, outOffset);
				
				outOffset += 4;
				outBuff.write(key, outOffset);
				outOffset += key.length;
				outBuff.writeInt8(0, outOffset);
				outOffset ++;

				if (compressed)
				{
					outBuff.writeInt8(0, outOffset);
					outOffset ++;
					data.copy(outBuff, outOffset);
				}
				else
				{
					outBuff.write(data, outOffset);	
				}
				
				outOffset += data.length;				

				var crcVal = crc.crc32(typeSignature);
				crc.crc32(data, crcVal);

				// CRC
				outBuff.writeInt32BE(crcVal ^ 0xffffffff, outOffset);
				outOffset += 4;

				// Writes the IDAT chunk after the zTXt
				outBuff.writeInt32BE(length, outOffset);
				outOffset += 4;
				outBuff.writeInt32BE(type, outOffset);
				outOffset += 4;

				origBuff.copy(outBuff, outOffset, inOffset);

				// Encodes the buffer using base64 if requested
				return base64encoded? outBuff.toString('base64') : outBuff;
			}

			outBuff.writeInt32BE(length, outOffset);
			outOffset += 4;
			outBuff.writeInt32BE(type, outOffset);
			outOffset += 4;

			origBuff.copy(outBuff, outOffset, inOffset, inOffset + length + 4);// +4 to move past the crc
			
			inOffset += length + 4;
			outOffset += length + 4;
		}
	}
	catch (e)
	{
		logger.error(e.message, {stack: e.stack});
		throw e;
	}
}

app.post('/', handleRequest);
app.get('/', handleRequest);

async function handleRequest(req, res) 
{
  try
  {
	  //Merge all parameters into body such that get and post works the same	
	  Object.assign(req.body, req.params, req.query);
	  
	  // Checks for HTML export request
	  if (req.body.html)
	  {
		var html = req.body.html;

		logger.info("HTML export referer: " + req.get("referer"));

		var wp = req.body.w;
		var w = (wp == null) ? 0 : parseInt(wp);

		var hp = req.body.h;
		var h = (hp == null) ? 0 : parseInt(hp);

		try
		{
			html = decodeURIComponent(
						zlib.inflateRawSync(
								new Buffer(decodeURIComponent(html), 'base64')).toString());
			
			//TODO May be this is not needed with Chrome?
			// Poor man's certificate handler for images
			html = html.replace(/https\:\/\//g , "http://");
			
			
			const browser = await puppeteer.launch({
				headless: true,
				args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
			});
			const page = await browser.newPage();
			// https://github.com/GoogleChrome/puppeteer/issues/728
			await page.goto(`data:text/html,${html}`, {waitUntil: 'networkidle0'});
			//await page.setContent(html);

			page.setViewport({width: w, height: h});

			var data = await page.screenshot({
			  type: 'png'
			});

			// Cross-origin access should be allowed to now
			res.header("Access-Control-Allow-Origin", "*");
			res.header('Content-disposition', 'attachment; filename="capture.png"');
			res.header('Content-type', 'image/png');
			  
			res.end(data);

			browser.close();
		}
		catch (e)
		{
			logger.info("Inflate failed for HTML input: " + html);
			throw e;
		}
	  }
	  else
	  {	
		var xml;
		if (req.body.url)
		{
			var urlRes = await fetch(req.body.url);
			xml = await urlRes.text();
			
			if (req.body.format == null)
				req.body.format = 'png';
		}
		else if (req.body.xmldata)
		{
			try
			{
				xml = zlib.inflateRawSync(
						new Buffer(decodeURIComponent(req.body.xmldata), 'base64')).toString();
			}
			catch (e)
			{
				logger.info("Inflate failed for XML input: " + req.body.xmldata);
				throw e;
			}
		}
		else
		{
			xml = req.body.xml;
		}
		
		if (xml != null && xml.indexOf("%3C") == 0)
		{
			xml = decodeURIComponent(xml);
		}
		
		// Extracts the compressed XML from the DIV in a HTML document
		if (xml != null && (xml.indexOf("<!DOCTYPE html>") == 0
				|| xml.indexOf("<!--[if IE]><meta http-equiv") == 0)) //TODO not tested!
		{
			try
			{
				var doc = new DOMParser().parseFromString(xml);
				var divs = doc.documentElement
						.getElementsByTagName("div");

				if (divs != null && divs.length > 0
						&& "mxgraph" == (divs.item(0).attributes
								.getNamedItem("class").nodeValue))
				{
					if (divs.item(0).nodeType == 1)
					{
						if (divs.item(0).hasAttribute("data-mxgraph"))
						{
							var jsonString = divs.item(0).getAttribute("data-mxgraph");

							if (jsonString != null)
							{
								var obj = JSON.parse(jsonString);
								xml = obj["xml"];
							}
						}
						else
						{
							divs = divs.item(0).getElementsByTagName("div");

							if (divs != null && divs.length > 0)
							{
								var tmp = divs.item(0).textContent;

								if (tmp != null)
								{
									tmp = zlib.inflateRawSync(new Buffer(tmp, 'base64')).toString();
									
									if (tmp != null && tmp.length > 0)
									{
										xml = decodeURIComponent(tmp);
									}
								}
							}
						}
					}
				}
			}
			catch (e)
			{
				// ignore
			}
		}
		
		// Extracts the URL encoded XML from the content attribute of an SVG node
		if (xml != null && (xml.indexOf(
				"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">") == 0))
		{//TODO not tested!
			try
			{
				var doc = new DOMParser().parseFromString(xml);

				if (doc != null && doc.documentElement != null && doc
						.documentElement.nodeName == "svg")
				{
					var content = doc.documentElement.getAttribute("content");
					
					if (content != null)
					{
						xml = content;
						
						if (xml.charAt(0) == '%')
						{
							xml = decodeURIComponent(xml);
						}
					}
				}
			}
			catch (e)
			{
				// ignore
			}
		}
		
		req.body.w = req.body.w || 0;
		req.body.h = req.body.h || 0;
		
		// Checks parameters
		if (req.body.format && xml && req.body.w * req.body.h <= MAX_AREA)
		{
			try
			{
				var reqStr = ((xml != null) ? "xml=" + xml.length : "")
					+ ((req.body.embedXml != null) ? " embed=" + req.body.embedXml : "") + " format="
					+ req.body.format;
					
				req.body.xml = xml;

				var t0 = Date.now();
				
				const browser = await puppeteer.launch({
					headless: true,
					args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox']
				});
				const page = await browser.newPage();
				await page.goto('http://www.draw.io/export3.html', {waitUntil: 'networkidle0'});

				const result = await page.evaluate((body) => {
						return render({
							xml: body.xml,
							format: body.format,
							w: body.w,
							h: body.h,
							border: body.border || 0,
							bg: body.bg,
							"from": body["from"],
							to: body.to,
							scale: body.scale || 1
						});
					}, req.body);

				//default timeout is 30000 (30 sec)
				await page.waitForSelector('#LoadingComplete');

				var bounds = await page.mainFrame().$eval('#LoadingComplete', div => div.getAttribute('bounds'));

				var pdfOptions = {format: 'A4'};

				if (bounds != null)
				{
					bounds = JSON.parse(bounds);

					var w = Math.ceil(bounds.x + bounds.width);
					var h = Math.ceil(bounds.y + bounds.height);

					page.setViewport({width: w, height: h});

					pdfOptions = {
						width: w + 'px',
						height: (h + 1) + 'px',
						margin: {top: '0px', bottom: '0px', left: '0px', right: '0px'}
					}
				}	  

				// Cross-origin access should be allowed to now
				res.header("Access-Control-Allow-Origin", "*");
				
				req.body.filename = req.body.filename || ("export." + req.body.format);
				
				if (req.body.format == 'png' || req.body.format == 'jpeg')
				{
					var data = await page.screenshot({
						type: req.body.format,
						fullPage: true
					});

					var base64encoded = req.body.base64 == "1";

					if (req.body.embedXml == "1" && req.body.format == 'png')
					{
						data = writePngWithText(data, "mxGraphModel", xml, true,
								base64encoded);
					}
					else
					{
						if (base64encoded)
						{
							data = data.toString('base64');
						}

						if (data.length == 0)
						{
							throw new Error("Invalid image");
						}
					}


					res.header('Content-disposition', 'attachment; filename="' + decodeURIComponent(req.body.filename) + '"');
					res.header('Content-type', base64encoded? 'text/plain' : ('image/' + req.body.format));
					res.header("Content-Length", data.length);

					res.end(data);

					var dt = Date.now() - t0;
					
					logger.info("Success " + reqStr + " dt=" + dt);
				}
				else if (req.body.format == 'pdf')
				{
					var data = await page.pdf(pdfOptions);

					res.header('Content-disposition', 'attachment; filename="' + decodeURIComponent(req.body.filename) + '"');
					res.header('Content-type', 'application/pdf');

					res.end(data);

					var dt = Date.now() - t0;
					
					logger.info("Success " + reqStr + " dt=" + dt);
				}
				else 
				{
					//BAD_REQUEST
					res.status(400).end("Unsupported Format!");
					logger.warn("Unsupported Format: " + req.body.format);
				}
				await browser.close();
			}
			catch (e)
			{
				res.status(500).end("Error!");
				
				var ip = (req.headers['x-forwarded-for'] ||
							 req.connection.remoteAddress ||
							 req.socket.remoteAddress ||
							 req.connection.socket.remoteAddress).split(",")[0];
				
				var reqStr = "ip=" + ip + " ";

				if (req.body.format != null)
				{
					reqStr += ("format=" + req.body.format + " ");
				}

				if (req.body.w != null)
				{
					reqStr += ("w=" + req.body.w + " ");
				}

				if (req.body.h != null)
				{
					reqStr += ("h=" + req.body.h + " ");
				}

				if (req.body.scale != null)
				{
					reqStr += ("s=" + req.body.scale + " ");
				}

				if (req.body.bg != null)
				{
					reqStr += ("bg=" + req.body.bg + " ");
				}

				if (req.body.xmlData != null)
				{
					reqStr += ("xmlData=" + req.body.xmlData.length + " ");
				}

				logger.warn("Handled exception: " + e.message
						+ " req=" + reqStr, {stack: e.stack});
				
			}
		}
		else
		{
			res.status(400).end("BAD REQUEST");
		}
		//INTERNAL_SERVER_ERROR
		res.status(500).end("Unknown error!");
	  }
  }
  catch(e)
  {
	  logger.error(e.message, {stack: e.stack});
	  //INTERNAL_SERVER_ERROR
	  res.status(500).end("Unknown error");
  }
};

app.listen(PORT, function () 
{
  console.log(`pdf-export app listening on port ${PORT}!`)
});
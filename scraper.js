// Parses the development applications at the South Australian The Rural City of Murray Bridge web
// site and places them in a database.
//
// Michael Bone
// 18th August 2018
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const urlparser = require("url");
const moment = require("moment");
const pdfjs = require("pdfjs-dist");
const tesseract = require("tesseract.js");
const jimp = require("jimp");
const fs = require("fs");
sqlite3.verbose();
const DevelopmentApplicationsUrl = "http://www.murraybridge.sa.gov.au/page.aspx?u=1022";
const CommentUrl = "mailto:council@murraybridge.sa.gov.au";
// All valid suburb names.
let SuburbNames = null;
// Sets up an sqlite database.
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text)");
            resolve(database);
        });
    });
}
// Inserts a row in the database if it does not already exist.
async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" because it was already present in the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Returns the text of the element with all whitespace removed, changed to lowercase and some
// punctuation removed (for example, the full stop from "Dev App No.").
function condenseText(element) {
    if (element === undefined || element.text === undefined)
        return undefined;
    return element.text.trim().replace(/[\s.,]/g, "").toLowerCase();
}
// Gets the highest Y co-ordinate of all elements that are considered to be in the same row as
// the specified element.
function getRowTop(elements, startElement) {
    let top = Number.MAX_VALUE;
    for (let element of elements)
        if (element.y < startElement.y + startElement.height && element.y + element.height > startElement.y)
            if (element.y < top)
                top = element.y;
    return top;
}
// Constructs a rectangle based on the intersection of the two specified rectangles.
function constructIntersection(rectangle1, rectangle2) {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}
// Constructs a rectangle based on the union of the two specified rectangles.
function constructUnion(rectangle1, rectangle2) {
    let x1 = Math.min(rectangle1.x, rectangle2.x);
    let x2 = Math.max(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y1 = Math.min(rectangle1.y, rectangle2.y);
    let y2 = Math.max(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
// Calculates the square of the Euclidean distance between two elements.
function calculateDistance(element1, element2) {
    let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
    let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
    if (point2.x < point1.x - element1.width / 5) // arbitrary overlap factor of 20%
        return Number.MAX_VALUE;
    return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
}
// Determines whether there is vertical overlap between two elements.
function isVerticalOverlap(element1, element2) {
    return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
}
// Gets the percentage of vertical overlap between two elements (0 means no overlap and 100 means
// 100% overlap; and, for example, 20 means that 20% of the second element overlaps somewhere
// with the first element).
function getVerticalOverlapPercentage(element1, element2) {
    let y1 = Math.max(element1.y, element2.y);
    let y2 = Math.min(element1.y + element1.height, element2.y + element2.height);
    return (y2 < y1) ? 0 : (((y2 - y1) * 100) / element2.height);
}
// Gets the element immediately to the right of the specified element.
function getRightElement(elements, element) {
    let closestElement = { text: undefined, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let rightElement of elements)
        if (isVerticalOverlap(element, rightElement) && calculateDistance(element, rightElement) < calculateDistance(element, closestElement))
            closestElement = rightElement;
    return (closestElement.text === undefined) ? undefined : closestElement;
}
// Gets the text to the right of the specified startElement up to the left hand side of the
// specified middleElement (adjusted left by 20% of the width of the middleElement as a safety
// precaution).  Only elements that overlap 50% or more in the vertical direction with the
// specified startElement are considered (ie. elements on the same "row").
function getRightRowText(elements, startElement, middleElement) {
    let rowElements = elements.filter(element => element.x > startElement.x + startElement.width &&
        element.x < middleElement.x - 0.2 * middleElement.width &&
        getVerticalOverlapPercentage(element, startElement) > 50);
    // Sort and then join the elements into a single string.
    let xComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
    rowElements.sort(xComparer);
    return rowElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}
// Gets the text to the right in a rectangle, where the rectangle is delineated by the positions in
// which the three specified strings of (case sensitive) text are found.
function getRightText(elements, topLeftText, rightText, bottomText) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.
    let topLeftElement = elements.find(element => element.text.trim() == topLeftText);
    let rightElement = (rightText === undefined) ? undefined : elements.find(element => element.text.trim() == rightText);
    let bottomElement = (bottomText === undefined) ? undefined : elements.find(element => element.text.trim() == bottomText);
    if (topLeftElement === undefined)
        return undefined;
    let x = topLeftElement.x + topLeftElement.width;
    let y = topLeftElement.y;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);
    let bounds = { x: x, y: y, width: width, height: height };
    // Gather together all elements that are at least 50% within the bounding rectangle.
    let intersectingElements = [];
    for (let element of elements) {
        let intersectingBounds = constructIntersection(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    // Sort the elements by Y co-ordinate and then by X co-ordinate.
    let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);
    // Join the elements into a single string.
    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}
// Gets the text downwards in a rectangle, where the rectangle is delineated by the positions in
// which the three specified strings of (case sensitive) text are found.
function getDownText(elements, topText, rightText, bottomText) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.
    let topElement = elements.find(element => element.text.trim() == topText);
    let rightElement = (rightText === undefined) ? undefined : elements.find(element => element.text.trim() == rightText);
    let bottomElement = (bottomText === undefined) ? undefined : elements.find(element => element.text.trim() == bottomText);
    if (topElement === undefined)
        return undefined;
    let x = topElement.x;
    let y = topElement.y + topElement.height;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);
    let bounds = { x: x, y: y, width: width, height: height };
    // Gather together all elements that are at least 50% within the bounding rectangle.
    let intersectingElements = [];
    for (let element of elements) {
        let intersectingBounds = constructIntersection(element, bounds);
        let intersectingArea = intersectingBounds.width * intersectingBounds.height;
        let elementArea = element.width * element.height;
        if (elementArea > 0 && intersectingArea * 2 > elementArea && element.text !== ":")
            intersectingElements.push(element);
    }
    // Sort the elements by Y co-ordinate and then by X co-ordinate.
    let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    intersectingElements.sort(elementComparer);
    // Join the elements into a single string.
    return intersectingElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}
// Parses the details from the elements associated with a single development application.
function parseApplicationElements(elements, startElement, informationUrl) {
    // Find the "Assessment Number" text.
    let assessmentElement = elements.find(element => element.y > startElement.y && element.text.trim().toLowerCase().startsWith("assessment"));
    let assessmentText = condenseText(assessmentElement);
    if (assessmentText === "assessment") {
        let assessmentNumberElement = getRightElement(elements, assessmentElement);
        let assessmentNumberText = condenseText(assessmentNumberElement);
        if (assessmentNumberText !== "number") {
            console.log("Could not find the \"Assessment Number\" text on the PDF page for the current development application.  The development application will be ignored.");
            return undefined;
        }
    }
    else if (assessmentText !== "assessmentnumber") {
        console.log("Could not find the \"Assessment Number\" text on the PDF page for the current development application.  The development application will be ignored.");
        return undefined;
    }
    // Find the "Applicant" text.
    let applicantElement = elements.find(element => element.y > startElement.y && element.text.trim().toLowerCase() === "applicant");
    // Find the "Builder" text.
    let builderElement = elements.find(element => element.y > startElement.y && element.text.trim().toLowerCase() === "builder");
    // One of either the applicant or builder elements is required in order to determine where
    // the description text starts on the X axis (and where the development application number
    // and address end on the X axis).
    let middleElement = (applicantElement === undefined) ? builderElement : applicantElement;
    if (middleElement === undefined) {
        console.log("Could not find the \"Applicant\" or \"Builder\" text on the PDF page for the current development application.  The development application will be ignored.");
        return undefined;
    }
    let applicationNumber = getRightRowText(elements, startElement, middleElement).trim().replace(/\s/g, "");
    applicationNumber = applicationNumber.replace(/[IlL\[\]\|]/g, "/"); // for example, converts "17I2017" to "17/2017"
    if (applicationNumber === "") {
        console.log("Could not find the application number on the PDF page for the current development application.  The development application will be ignored.");
        return undefined;
    }
    console.log(`Application Number: ${applicationNumber}`);
    // Search to the right of "Dev App No." for the lodged date (including up and down a few
    // "lines" from the "Dev App No." text because sometimes the lodged date is offset vertically
    // by a fair amount; in some cases offset up and in other cases offset down).
    let dateElements = elements.filter(element => element.x >= middleElement.x &&
        element.y + element.height > startElement.y - startElement.height &&
        element.y < startElement.y + 2 * startElement.height &&
        moment(element.text.trim(), "D/MM/YYYY", true).isValid());
    // Select the left most date (ie. favour the "lodged" date over the "final descision" date).
    let receivedDate = undefined;
    let receivedDateElement = dateElements.reduce((previous, current) => ((previous === undefined || previous.x > current.x) ? current : previous), undefined);
    if (receivedDateElement !== undefined)
        receivedDate = moment(receivedDateElement.text.trim(), "D/MM/YYYY", true);
    console.log(`Received Date: ${receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : ""}`);
    // Set the element which delineates the top of the description text.
    let descriptionTopElement = (receivedDateElement === null) ? startElement : receivedDateElement;
    // Set the element which delineates the bottom left of the description text.
    let descriptionBottomLeftElement = middleElement;
    // Extract the description text.
    let descriptionElements = elements.filter(element => element.y > descriptionTopElement.y + descriptionTopElement.height &&
        element.y < descriptionBottomLeftElement.y &&
        element.x > descriptionBottomLeftElement.x - 0.2 * descriptionBottomLeftElement.width);
    // Sort the description elements by Y co-ordinate and then by X co-ordinate (the Math.max
    // expressions exist to allow for the Y co-ordinates of elements to be not exactly aligned;
    // for example, hyphens in text such as "Retail Fitout - Shop 7").
    let elementComparer = (a, b) => (a.y > b.y + Math.max(a.height, b.height)) ? 1 : ((a.y < b.y - Math.max(a.height, b.height)) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    descriptionElements.sort(elementComparer);
    // Construct the description from the description elements.
    let description = descriptionElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
    console.log(`Description: ${description}`);
    // Find the elements above (at least a "line" above) the "Assessment Number" text and to the
    // left of the middleElement.  These elements correspond to the address (assumed to be on one
    // single line).
    let addressElements = elements.filter(element => element.y < assessmentElement.y - assessmentElement.height &&
        element.x < middleElement.x);
    // Find the lowest address element (this is assumed to form part of the single line of the
    // address).
    let addressBottomElement = addressElements.reduce((previous, current) => ((previous === undefined || current.y > previous.y) ? current : previous), undefined);
    if (addressBottomElement === undefined) {
        console.log(`Application number ${applicationNumber} will be ignored because an address was not found (searching upwards from the "Assessment Number" text).`);
        return undefined;
    }
    // Obtain all elements on the same "line" as the lowest address element.
    addressElements = elements.filter(element => element.y < assessmentElement.y - assessmentElement.height &&
        element.x < middleElement.x &&
        element.y >= addressBottomElement.y - Math.max(element.height, addressBottomElement.height));
    // Sort the address elements by Y co-ordinate and then by X co-ordinate (the Math.max
    // expressions exist to allow for the Y co-ordinates of elements to be not exactly aligned).
    elementComparer = (a, b) => (a.y > b.y + Math.max(a.height, b.height)) ? 1 : ((a.y < b.y - Math.max(a.height, b.height)) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    addressElements.sort(elementComparer);
    // Construct the address from the discovered address elements.
    let address = addressElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
    console.log(`Address: ${address}`);
    // Do replacement of ﬁ with "fi"
    // for (let element of elements)
    //     console.log(`[${Math.round(element.x)},${Math.round(element.y)}] ${element.text}`);
    console.log("----------");
    return [];
    // let applicationNumber = getRightText(elements, "Application No", "Application Date", "Applicants Name");
    // let receivedDate = getRightText(elements, "Application Date", "Planning Approval", "Application received");
    let houseNumber = getRightText(elements, "Property House No", "Planning Conditions", "Lot");
    let streetName = getRightText(elements, "Property street", "Planning Conditions", "Property suburb");
    let suburbName = getRightText(elements, "Property suburb", "Planning Conditions", "Title");
    // let description = getDownText(elements, "Development Description", "Relevant Authority", undefined);
    // let address = "";
    if (houseNumber !== undefined)
        address += houseNumber.trim();
    if (streetName !== undefined)
        address += ((address === "") ? "" : " ") + streetName.trim();
    if (suburbName === undefined || suburbName.trim() === "")
        address = ""; // ignore the application because there is no suburb
    // Attempt to add the state and post code to the suburb.
    let suburbNameAndPostCode = SuburbNames[suburbName.trim()];
    if (suburbNameAndPostCode === undefined)
        suburbNameAndPostCode = suburbName.trim();
    address += ((address === "") ? "" : ", ") + suburbNameAndPostCode;
    address = address.trim();
    // A valid application must at least have an application number and an address.
    if (applicationNumber === "" || address === "")
        return undefined;
    let parsedReceivedDate = moment(receivedDate, "D/MM/YYYY", true); // allows the leading zero of the day to be omitted
    return {
        applicationNumber: applicationNumber,
        address: address,
        description: ((description === "") ? "No description provided" : description),
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: parsedReceivedDate.isValid() ? parsedReceivedDate.format("YYYY-MM-DD") : ""
    };
}
// Parses an image (from a PDF file).
async function parseImage(image, bounds) {
    // Convert the image data into a format that can be used by jimp.
    let pixelSize = (8 * image.data.length) / (image.width * image.height);
    let jimpImage = null;
    if (pixelSize === 1) {
        // A monochrome image (one bit per pixel).
        jimpImage = new jimp(image.width, image.height);
        for (let x = 0; x < image.width; x++) {
            for (let y = 0; y < image.height; y++) {
                let index = y * (image.width / 8);
                let bitIndex = x % 8;
                let byteIndex = (x - bitIndex) / 8;
                index += byteIndex;
                let color = null;
                if ((image.data[index] & (128 >> bitIndex)) === 0)
                    color = jimp.rgbaToInt(0, 0, 0, 255); // black pixel
                else
                    color = jimp.rgbaToInt(255, 255, 255, 255); // white pixel
                jimpImage.setPixelColor(color, x, y);
            }
        }
    }
    else {
        // Assume a 24 bit colour image (3 bytes per pixel).
        jimpImage = new jimp(image.width, image.height);
        for (let x = 0; x < image.width; x++) {
            for (let y = 0; y < image.height; y++) {
                let index = (y * image.width * 3) + (x * 3);
                let color = jimp.rgbaToInt(image.data[index], image.data[index + 1], image.data[index + 2], 255);
                jimpImage.setPixelColor(color, x, y);
            }
        }
    }
    // Note that textord_old_baselines is set to 0 so that text that is offset by half the height
    // of the the font is correctly recognised.
    let imageBuffer = await new Promise((resolve, reject) => jimpImage.getBuffer(jimp.MIME_PNG, (error, buffer) => error ? reject(error) : resolve(buffer)));
    let result = await new Promise((resolve, reject) => { tesseract.recognize(imageBuffer, { textord_old_baselines: "0" }).then(function (result) { resolve(result); }); });
    tesseract.terminate();
    if (global.gc)
        global.gc();
    // Simplify the lines (remove most of the information generated by tesseract.js).
    let elements = [];
    if (result.blocks && result.blocks.length)
        for (let block of result.blocks)
            for (let paragraph of block.paragraphs)
                for (let line of paragraph.lines)
                    elements = elements.concat(line.words.map(word => {
                        return {
                            text: word.text,
                            confidence: word.confidence,
                            choiceCount: word.choices.length,
                            x: word.bbox.x0 + bounds.x,
                            y: word.bbox.y0 + bounds.y,
                            width: (word.bbox.x1 - word.bbox.x0),
                            height: (word.bbox.y1 - word.bbox.y0)
                        };
                    }));
    return elements;
}
async function parsePdf(url) {
    let developmentApplications = [];
    // Read the PDF.
    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    // Parse the PDF.  Each page has the details of multiple applications.
    let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
    console.log("Only parsing the first few pages for testing purposes.");
    console.log("Get \"Records\" from first page and ensure that total is correct.");
    // for (let index = 0; index < pdf.numPages; index++) {
    for (let index = 4; index < 10; index++) {
        console.log(`Page ${index + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(index + 1);
        let viewportTest = await page.getViewport(1.0);
        let operators = await page.getOperatorList();
        // Find and parse any images in the current PDF page.
        let elements = [];
        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] !== pdfjs.OPS.paintImageXObject && operators.fnArray[index] !== pdfjs.OPS.paintImageMaskXObject)
                continue;
            // The operator either contains the name of an image or an actual image.
            let image = operators.argsArray[index][0];
            if (typeof image === "string")
                image = page.objs.get(image); // get the actual image using its name
            // Obtain the transform that applies to the image.
            let transform = (index - 1 >= 0 && operators.fnArray[index - 1] === pdfjs.OPS.transform) ? operators.argsArray[index - 1] : undefined;
            if (transform === undefined) // a transform is needed
                continue;
            // Parse the text from the image.
            let bounds = {
                x: (transform[4] * image.height) / transform[3],
                y: ((viewportTest.height - transform[5] - transform[3]) * image.height) / transform[3],
                width: image.width,
                height: image.height
            };
            elements = elements.concat(await parseImage(image, bounds));
        }
        // Sort the elements by Y co-ordinate and then by X co-ordinate.
        let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        elements.sort(elementComparer);
        // Group the elements into sections based on where the "Dev App No." text starts (and
        // any other element the "Dev Ap No." elements line up with horizontally with a margin
        // of error equal to about the height of the "Dev App No." text; in order to capture the
        // lodged date, which may be higher up than the "Dev App No." text).
        let startElements = [];
        for (let startElement of elements.filter(element => element.text.trim().toLowerCase().startsWith("dev"))) {
            // Check that the elements next to "Dev" produce the text "Dev App No.".  Take care
            // as the text may possibly be spread across one, two or three elements (allow for
            // all these possibilities).
            let startText = condenseText(startElement);
            if (startText === "dev") {
                startElement = getRightElement(elements, startElement);
                startText = condenseText(startElement);
                if (startText === "app") {
                    startElement = getRightElement(elements, startElement);
                    startText = condenseText(startElement);
                    if (startText !== "no")
                        continue; // not "Dev App No."
                }
                else if (startText !== "appno") {
                    continue; // not "Dev App No."
                }
            }
            else if (startText === "devapp") {
                startElement = getRightElement(elements, startElement);
                startText = condenseText(startElement);
                if (startText !== "no")
                    continue; // not "Dev App No."
            }
            else if (startText !== "devappno") {
                continue; // not "Dev App No."
            }
            startElements.push(startElement);
        }
        let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
        startElements.sort(yComparer);
        let applicationElementGroups = [];
        for (let index = 0; index < startElements.length; index++) {
            // Determine the highest Y co-ordinate of this row and the next row (or the bottom of
            // the current page).  Allow some leeway vertically (add some extra height) because
            // in some cases the lodged date is a fair bit higher up than the "Dev App No." text.
            let startElement = startElements[index];
            let raisedStartElement = {
                text: startElement.text,
                x: startElement.x,
                y: startElement.y - 2 * startElement.height,
                width: startElement.width,
                height: startElement.height
            };
            let rowTop = getRowTop(elements, raisedStartElement);
            let nextRowTop = (index + 1 < startElements.length) ? getRowTop(elements, startElements[index + 1]) : Number.MAX_VALUE;
            // Extract all elements between the two rows.
            applicationElementGroups.push({ startElement: startElements[index], elements: elements.filter(element => element.y >= rowTop && element.y + element.height < nextRowTop) });
        }
        // Parse the development application from each group of elements (ie. a section of the
        // current page of the PDF document).
        for (let applicationElementGroup of applicationElementGroups) {
            let developmentApplication = parseApplicationElements(applicationElementGroup.elements, applicationElementGroup.startElement, url);
            if (developmentApplication !== undefined)
                developmentApplications.push(developmentApplication);
        }
    }
    return developmentApplications;
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
// Parses the development applications.
async function main() {
    // Ensure that the database exists.
    let database = await initializeDatabase();
    // Read the files containing all possible suburb names.
    SuburbNames = {};
    for (let suburb of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n"))
        SuburbNames[suburb.split(",")[0]] = suburb.split(",")[1];
    // Retrieve the page that contains the links to the PDFs.
    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request({ url: DevelopmentApplicationsUrl, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);
    let pdfUrls = [];
    for (let element of $("td.uContentListDesc a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl);
        pdfUrl.protocol = "http"; // force to use HTTP instead of HTTPS
        if (!pdfUrls.some(url => url === pdfUrl.href)) // avoid duplicates
            pdfUrls.push(pdfUrl.href);
    }
    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }
    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).
    let selectedPdfUrls = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    if (getRandom(0, 2) === 0)
        selectedPdfUrls.reverse();
    // selectedPdfUrls = [ "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202018.pdf", "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20February%202017.pdf" ];
    // selectedPdfUrls = [ "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202018.pdf" ];
    selectedPdfUrls = ["http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20February%202017.pdf"];
    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);
        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).
        if (global.gc)
            global.gc();
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}
main().then(() => console.log("Complete.")).catch(error => console.error(error));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsa0dBQWtHO0FBQ2xHLHNDQUFzQztBQUN0QyxFQUFFO0FBQ0YsZUFBZTtBQUNmLG1CQUFtQjtBQUVuQixZQUFZLENBQUM7O0FBRWIsbUNBQW1DO0FBQ25DLGtEQUFrRDtBQUNsRCxtQ0FBbUM7QUFDbkMsaUNBQWlDO0FBQ2pDLGlDQUFpQztBQUNqQyxvQ0FBb0M7QUFDcEMsMENBQTBDO0FBQzFDLDZCQUE2QjtBQUM3Qix5QkFBeUI7QUFFekIsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBRWxCLE1BQU0sMEJBQTBCLEdBQUcsb0RBQW9ELENBQUM7QUFDeEYsTUFBTSxVQUFVLEdBQUcsdUNBQXVDLENBQUM7QUFLM0QsMEJBQTBCO0FBRTFCLElBQUksV0FBVyxHQUFHLElBQUksQ0FBQztBQUV2Qiw4QkFBOEI7QUFFOUIsS0FBSyxVQUFVLGtCQUFrQjtJQUM3QixPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQ25DLElBQUksUUFBUSxHQUFHLElBQUksT0FBTyxDQUFDLFFBQVEsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNuRCxRQUFRLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRTtZQUNwQixRQUFRLENBQUMsR0FBRyxDQUFDLDhMQUE4TCxDQUFDLENBQUM7WUFDN00sT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ3RCLENBQUMsQ0FBQyxDQUFDO0lBQ1AsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDO0FBRUQsOERBQThEO0FBRTlELEtBQUssVUFBVSxTQUFTLENBQUMsUUFBUSxFQUFFLHNCQUFzQjtJQUNyRCxPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQ25DLElBQUksWUFBWSxHQUFHLFFBQVEsQ0FBQyxPQUFPLENBQUMsMkRB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
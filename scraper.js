// Parses the development applications at the South Australian The Rural City of Murray Bridge web
// site and places them in a database.
//
// Michael Bone
// 18th August 2018
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
console.log("Preventing the \"pre-main prep time\" message from tesseract.js by updating node_modules/tesseract.js-core/index.js.");
let data = fs.readFileSync("node_modules/tesseract.js-core/index.js").toString().replace(/Module.\$a\("pre-main prep time\: "\+\(Date\.now\(\)\-tj\)\+" ms"\)/g, "true");
fs.writeFileSync("node_modules/tesseract.js-core/index.js", data);
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const urlparser = require("url");
const moment = require("moment");
const pdfjs = require("pdfjs-dist");
const tesseract = require("tesseract.js");
const jimp = require("jimp");
const didyoumean = require("didyoumean2");
sqlite3.verbose();
const DevelopmentApplicationsUrl = "http://www.murraybridge.sa.gov.au/page.aspx?u=1022";
const CommentUrl = "mailto:council@murraybridge.sa.gov.au";
// All valid street and suburb names.
let SuburbNames = null;
let StreetSuffixes = null;
let StreetNames = null;
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
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Gets the highest Y co-ordinate of all elements that are considered to be in the same row as
// the specified element.  Take care to avoid extremely tall elements (because these may otherwise
// be considered as part of all rows and effectively force the return value of this function to
// the same value, regardless of the value of startElement).
function getRowTop(elements, startElement) {
    let top = startElement.y;
    for (let element of elements)
        if (element.y < startElement.y + startElement.height && element.y + element.height > startElement.y) // check for overlap
            if (getVerticalOverlapPercentage(startElement, element) > 50) // avoids extremely tall elements
                if (element.y < top)
                    top = element.y;
    return top;
}
// Constructs a rectangle based on the intersection of the two specified rectangles.
function intersect(rectangle1, rectangle2) {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}
// Calculates the area of a rectangle.
function getArea(rectangle) {
    return rectangle.width * rectangle.height;
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
// Gets the element immediately to the right of the specified element (but ignore elements that
// appear after a large horizontal gap).
function getRightElement(elements, element) {
    let closestElement = { text: undefined, confidence: 0, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let rightElement of elements)
        if (isVerticalOverlap(element, rightElement) && // ensure that there is at least some vertical overlap
            getVerticalOverlapPercentage(element, rightElement) > 50 && // avoid extremely tall elements (ensure at least 50% overlap)
            (rightElement.x > element.x + element.width) && // ensure the element actually is to the right
            (rightElement.x - (element.x + element.width) < 30) && // avoid elements that appear after a large gap (arbitrarily ensure less than a 30 pixel gap horizontally)
            calculateDistance(element, rightElement) < calculateDistance(element, closestElement)) // check if closer than any element encountered so far
            closestElement = rightElement;
    return (closestElement.text === undefined) ? undefined : closestElement;
}
// Gets the text to the right of the specified startElement up to the left hand side of the
// specified middleElement (adjusted left by 20% of the width of the middleElement as a safety
// precaution).  Only elements that overlap 50% or more in the vertical direction with the
// specified startElement are considered (ie. elements on the same "row" and not too tall).
function getRightRowText(elements, startElement, middleElement) {
    let rowElements = elements.filter(element => element.x > startElement.x + startElement.width &&
        element.x < middleElement.x - 0.2 * middleElement.width &&
        getVerticalOverlapPercentage(element, startElement) > 50);
    // Sort and then join the elements into a single string.
    let xComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
    rowElements.sort(xComparer);
    return rowElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}
// Reads all the address information into global objects.
function readAddressInformation() {
    StreetNames = {};
    for (let line of fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetNameTokens = line.split(",");
        let streetName = streetNameTokens[0].trim();
        let suburbName = streetNameTokens[1].trim();
        if (StreetNames[streetName] === undefined)
            StreetNames[streetName] = [];
        StreetNames[streetName].push(suburbName); // several suburbs may exist for the same street name
    }
    StreetSuffixes = {};
    for (let line of fs.readFileSync("streetsuffixes.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetSuffixTokens = line.split(",");
        StreetSuffixes[streetSuffixTokens[0].trim().toLowerCase()] = streetSuffixTokens[1].trim();
    }
    SuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.split(",");
        let suburbName = suburbTokens[0].trim().toLowerCase();
        let suburbStateAndPostCode = suburbTokens[1].trim();
        SuburbNames[suburbName] = suburbStateAndPostCode;
    }
}
// Gets the elements on the line above (typically an address line).  Note that the left hand side
// of the leftElement is used to limit how far left the search for elements is performed (and so
// avoids artefacts created right at the left hand side edge of the page being included as valid
// text, such as "|" in the November 2016 PDF on page 16).
function getAboveElements(elements, leftElement, belowElement, middleElement) {
    // Find the elements above (at least a "line" above) the specified "below" element and to the
    // left of the middleElement.  These elements correspond to address elements (assumed to be on
    // one single line).
    let addressElements = elements.filter(element => element.y < belowElement.y - belowElement.height &&
        element.x < middleElement.x - 0.2 * middleElement.width &&
        element.x > leftElement.x - leftElement.height); // use height rather than width purposely (to avoid too much width)
    // Find the lowest address element (this is assumed to form part of the single line of the
    // address).  Note that middleElement.x is divided by two so that elements on the very right
    // hand side of the rectangle being search will be ignored (these tend to be descriptions
    // that have been moved too far to the left, overlapping the rectangle in which the address
    // is expected to appear).
    let addressBottomElement = addressElements.reduce((previous, current) => ((current.x < middleElement.x / 2) && (previous === undefined || current.y > previous.y) ? current : previous), undefined);
    if (addressBottomElement === undefined)
        return [];
    // Obtain all elements on the same "line" as the lowest address element.
    addressElements = elements.filter(element => element.y < belowElement.y - belowElement.height &&
        element.x < middleElement.x - 0.2 * middleElement.width &&
        element.x > leftElement.x - leftElement.height && // use height rather than width purposely (to avoid too much width)
        element.y >= addressBottomElement.y - Math.max(element.height, addressBottomElement.height));
    // Sort the address elements by Y co-ordinate and then by X co-ordinate (the Math.max
    // expressions exist to allow for the Y co-ordinates of elements to be not exactly aligned).
    let elementComparer = (a, b) => (a.y > b.y + Math.max(a.height, b.height)) ? 1 : ((a.y < b.y - Math.max(a.height, b.height)) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    addressElements.sort(elementComparer);
    // Remove any smaller elements (say less than half the area) that are 90% or more encompassed
    // by another element (this then avoids some artefacts of the text recognition, ie. elements
    // such as "r~" and "-" that can otherwise overlap the main text).
    addressElements = addressElements.filter(element => !addressElements.some(otherElement => getArea(otherElement) > 2 * getArea(element) && // smaller element (ie. the other element is at least double the area)
        getArea(element) > 0 &&
        getArea(intersect(element, otherElement)) / getArea(element) > 0.9));
    // Remove any address elements that occur after a sizeable gap.  Any such elements are very
    // likely part of the description (not the address) because sometimes the description is
    // moved to the left, closer to the address (see "Crystal Report - DevAppSeptember 2015.pdf").
    for (let index = 1; index < addressElements.length; index++) {
        if (addressElements[index].x - (addressElements[index - 1].x + addressElements[index - 1].width) > 50) { // gap greater than 50 pixels
            if (addressElements[index - 1].confidence >= 60 && addressElements[index].confidence >= 60) { // avoid random marks and the edge of the paper being recognised as text
                addressElements.length = index; // remove the element and all following elements that appear after a large gap
                break;
            }
        }
    }
    return addressElements;
}
// Finds the element containing the assessment number text.
function getAssessmentNumberElement(elements, startElement) {
    // Find the "Assessment Number" or "Asses Num" text (allowing for spelling errors).
    let assessmentNumberElement = elements.find(element => element.y > startElement.y &&
        didyoumean(element.text, ["Assessment Number", "Asses Num"], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 3, trimSpace: true }) !== null);
    if (assessmentNumberElement !== undefined)
        return assessmentNumberElement;
    // Find any occurrences of the text "Assessment" or "Asses".
    let assessmentElements = elements.filter(element => element.y > startElement.y &&
        didyoumean(element.text, ["Assessment", "Asses"], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null);
    // Check if any of the occurrences of "Assessment" are followed by "Number" or "Num".
    for (let assessmentElement of assessmentElements) {
        let assessmentRightElement = getRightElement(elements, assessmentElement);
        if (assessmentRightElement !== undefined && didyoumean(assessmentRightElement.text, ["Number", "Num"], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null)
            return assessmentElement;
    }
    return undefined;
}
// Gets the element containining the received date.
function getReceivedDateElement(elements, startElement, middleElement) {
    // Search to the right of "Dev App No." for the lodged date (including up and down a few
    // "lines" from the "Dev App No." text because sometimes the lodged date is offset vertically
    // by a fair amount; in some cases offset up and in other cases offset down).
    let dateElements = elements.filter(element => element.x >= middleElement.x &&
        element.y + element.height > startElement.y - 2 * startElement.height &&
        element.y < startElement.y + 3 * startElement.height &&
        moment(element.text.trim(), "D/MM/YYYY", true).isValid());
    // Select the left most date (ie. favour the "lodged" date over the "final descision" date).
    let receivedDateElement = dateElements.reduce((previous, current) => ((previous === undefined || previous.x > current.x) ? current : previous), undefined);
    return receivedDateElement;
}
// Gets the description.
function getDescription(elements, startElement, middleElement, receivedDateElement) {
    // Set the element which delineates the top of the description text.
    let descriptionTopElement = (receivedDateElement === undefined) ? startElement : receivedDateElement;
    // Set the element which delineates the bottom left of the description text.
    let descriptionBottomLeftElement = middleElement;
    // Extract the description text.
    let descriptionElements = elements.filter(element => element.y > descriptionTopElement.y + descriptionTopElement.height &&
        element.y < descriptionBottomLeftElement.y &&
        element.x > descriptionBottomLeftElement.x - 0.2 * descriptionBottomLeftElement.width);
    // Sort the description elements by Y co-ordinate and then by X co-ordinate (the Math.max
    // expressions exist to allow for the Y co-ordinates of elements to be not exactly aligned;
    // for example, hyphens in text such as "Retail Fitout - Shop 7").
    let elementComparer = (a, b) => (a.y > b.y + (Math.max(a.height, b.height) * 2) / 3) ? 1 : ((a.y < b.y - (Math.max(a.height, b.height) * 2) / 3) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    descriptionElements.sort(elementComparer);
    // Construct the description from the description elements.
    return descriptionElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl");
}
// Formats (and corrects) an address.
function formatAddress(address) {
    address = address.trim();
    if (address === "")
        return { text: "", hasSuburb: false, hasStreet: false };
    let tokens = address.split(" ");
    // Correct one case where "T CE" was parsed instead of "TCE" (in the May 2016 PDF).
    address = address.replace(/ T CE /g, "TCE");
    // It is common for an invalid postcode of "0" to appear on the end of an address.  Remove
    // this if it is present.  For example, "Bremer Range RD CALLINGTON 0".  Remove the post code
    // because this will be derived based on the suburb.
    let postCode = tokens[tokens.length - 1];
    if (/^[0-9]{4}$/.test(postCode) || postCode === "O" || postCode === "0" || postCode === "D")
        tokens.pop();
    // Remove the state abbreviation (this will be determined using the suburb).
    let state = tokens[tokens.length - 1];
    if (didyoumean(state, ["SA"], { caseSensitive: true, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 1, trimSpace: true }) !== null)
        tokens.pop();
    // Pop tokens from the end of the array until a valid suburb name is encountered (allowing
    // for a few spelling errors).
    let suburbName = null;
    for (let index = 1; index <= 4; index++) {
        let suburbNameMatch = didyoumean(tokens.slice(-index).join(" "), Object.keys(SuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
        if (suburbNameMatch !== null) {
            suburbName = SuburbNames[suburbNameMatch];
            tokens.splice(-index, index); // remove elements from the end of the array           
            break;
        }
    }
    if (suburbName === null) // suburb name not found (or not recognised)
        return { text: address, hasSuburb: false, hasStreet: false };
    // Expand an abbreviated street suffix.  For example, expand "RD" to "Road".
    let streetSuffixAbbreviation = tokens.pop() || "";
    let streetSuffix = StreetSuffixes[streetSuffixAbbreviation.toLowerCase()] || streetSuffixAbbreviation;
    // Allow minor spelling corrections in the remaining tokens to construct a street name.
    let streetName = (tokens.join(" ") + " " + streetSuffix).trim();
    let streetNameMatch = didyoumean(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
    if (streetNameMatch !== null)
        streetName = streetNameMatch;
    return { text: (streetName + ((streetName === "") ? "" : ", ") + suburbName).trim(), hasSuburb: true, hasStreet: (streetName.length > 0) };
}
// Gets and formats the address.
function getAddress(elements, assessmentNumberElement, middleElement) {
    let addressElements = getAboveElements(elements, assessmentNumberElement, assessmentNumberElement, middleElement);
    if (addressElements.length === 0)
        return undefined;
    // Construct the address from the discovered address elements (and attempt to correct some
    // spelling errors).
    let address = addressElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/\\\//g, "V").replace(/‘/g, "").replace(/’/g, "").replace(/“/g, "").replace(/”/g, "").replace(/—/g, "").replace(/_/g, "").replace(/\./g, "").replace(/\-/g, "").replace(/\//g, "").replace(/!/g, "");
    if (address.startsWith("Dev Cost") || address.startsWith("LOT:") || address.startsWith("LOT ") || address.startsWith("HD:") || address.startsWith("HD ")) // finding this text instead of an address indicates that there is no address present
        return undefined;
    // If the address starts with a suburb then there may be a street name on the line above.
    let formattedAddress = formatAddress(address);
    if (!formattedAddress.hasStreet) {
        let streetElements = getAboveElements(elements, assessmentNumberElement, addressElements[0], middleElement);
        if (streetElements.length > 0) {
            let street = streetElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/\\\//g, "V").replace(/‘/g, "").replace(/’/g, "").replace(/“/g, "").replace(/”/g, "").replace(/—/g, "").replace(/_/g, "").replace(/\./g, "").replace(/\-/g, "").replace(/\//g, "").replace(/!/g, "");
            if (!street.startsWith("Dev Cost") && !street.startsWith("LOT:") && !street.startsWith("LOT ") && !street.startsWith("HD:") && !street.startsWith("HD ")) // finding this text instead of an address indicates that there is no address present
                formattedAddress = formatAddress(street + " " + formattedAddress.text);
        }
    }
    if (formattedAddress.text === "" || formattedAddress.text.startsWith("Dev Cost") || formattedAddress.text.startsWith("Total Area"))
        return undefined;
    return formattedAddress.text;
}
// Parses the details from the elements associated with a single development application.
function parseApplicationElements(elements, startElement, informationUrl) {
    // Find the "Assessment Number" or "Asses Num" text.
    let assessmentNumberElement = getAssessmentNumberElement(elements, startElement);
    if (assessmentNumberElement === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the \"Assessment Number\" or \"Asses Num\" text on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    // Find the "Applicant" text.
    let applicantElement = elements.find(element => element.y > startElement.y &&
        didyoumean(element.text, ["Applicant"], { caseSensitive: true, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 3, trimSpace: true }) !== null);
    // Find the "Builder" text.
    let builderElement = elements.find(element => element.y > startElement.y &&
        didyoumean(element.text, ["Builder"], { caseSensitive: true, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 3, trimSpace: true }) !== null);
    // One of either the applicant or builder elements is required in order to determine where
    // the description text starts on the X axis (and where the development application number
    // and address end on the X axis).
    let middleElement = (applicantElement === undefined) ? builderElement : applicantElement;
    if (middleElement === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the \"Applicant\" or \"Builder\" text on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    // Get the application number.
    let applicationNumber = getRightRowText(elements, startElement, middleElement).trim().replace(/\s/g, "");
    applicationNumber = applicationNumber.replace(/[IlL\[\]\|’,!\(\)]/g, "/").replace(/°/g, "0").replace(/'\//g, "1").replace(/\/\//g, "1/").replace(/201\?/g, "2017").replace(/‘/g, ""); // for example, converts "17I2017" to "17/2017"
    if (applicationNumber.length >= 6 && /120[0-9][0-9]$/.test(applicationNumber))
        applicationNumber = applicationNumber.substring(0, applicationNumber.length - 5) + "/" + applicationNumber.substring(applicationNumber.length - 4); // for example, converts "35612015" to "356/2015"
    if (applicationNumber === "") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the application number on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    console.log(`    Found \"${applicationNumber}\".`);
    // Get the received date.
    let receivedDate = undefined;
    let receivedDateElement = getReceivedDateElement(elements, startElement, middleElement);
    if (receivedDateElement !== undefined)
        receivedDate = moment(receivedDateElement.text.trim(), "D/MM/YYYY", true);
    // Get the description.
    let description = getDescription(elements, startElement, middleElement, receivedDateElement);
    // Get the address.
    let address = getAddress(elements, assessmentNumberElement, middleElement);
    if (address === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Application number ${applicationNumber} will be ignored because an address was not found or parsed (searching upwards from the "Assessment Number" or \"Asses Num\" text).  Elements: ${elementSummary}`);
        return undefined;
    }
    return {
        applicationNumber: applicationNumber,
        address: address,
        description: ((description === "") ? "No description provided" : description),
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: (receivedDate !== undefined && receivedDate.isValid()) ? receivedDate.format("YYYY-MM-DD") : ""
    };
}
// Segments an image vertically and horizontally based on blocks of white (or almost white) pixels
// in order to avoid using too much memory.  Very often a large image will be mostly white space.
// A very simple horizontal and then vertical search is performed for consecutive lines of white
// (or mostly white) pixels.
function segmentImage(jimpImage) {
    let bounds = { x: 0, y: 0, width: jimpImage.bitmap.width, height: jimpImage.bitmap.height };
    // Only segment large images (do not waste time on small images which are already small enough
    // that they will not cause too much memory to be used).
    if (jimpImage.bitmap.width * jimpImage.bitmap.height < 400 * 400)
        return [{ image: jimpImage, bounds: bounds }];
    // Segment image based on white space.
    let rectangles = [];
    let horizontalRectangles = [];
    let verticalRectangles = segmentImageVertically(jimpImage, bounds);
    for (let verticalRectangle of verticalRectangles)
        horizontalRectangles = horizontalRectangles.concat(segmentImageHorizontally(jimpImage, verticalRectangle));
    for (let horizontalRectangle of horizontalRectangles)
        rectangles = rectangles.concat(segmentImageVertically(jimpImage, horizontalRectangle));
    // Extract images delineated by the white space.
    let segments = [];
    for (let rectangle of rectangles) {
        let croppedJimpImage = new jimp(rectangle.width, rectangle.height);
        croppedJimpImage.blit(jimpImage, 0, 0, rectangle.x, rectangle.y, rectangle.width, rectangle.height);
        segments.push({ image: croppedJimpImage, bounds: rectangle });
    }
    return segments;
}
// Segments an image vertically (within the specified bounds) by searching for blocks of
// consecutive, white (or close to white) horizontal lines.
function segmentImageVertically(jimpImage, bounds) {
    let whiteBlocks = [];
    let isPreviousWhiteLine = false;
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
        // Count the number of white pixels across the current horizontal line.
        let whiteCount = 0;
        for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
            let value = jimpImage.getPixelColor(x, y);
            if (value === 0xffffffff) // performance improvement (for the common case of a pure white pixel)
                whiteCount++;
            else {
                let color = jimp.intToRGBA(value);
                if (color.r > 240 && color.g > 240 && color.b > 240) // white or just off-white
                    whiteCount++;
            }
        }
        // If the line is mostly white pixels then it is considered a white line.
        let isWhiteLine = (whiteCount >= bounds.width - 2); // allow up to two non-white pixels
        if (isWhiteLine) {
            if (isPreviousWhiteLine)
                whiteBlocks[whiteBlocks.length - 1].height++; // increase the size of the current block
            else
                whiteBlocks.push({ y: y, height: 1 }); // start a new block
        }
        isPreviousWhiteLine = isWhiteLine;
    }
    // Only keep blocks of white that consist of 25 consecutive lines or more (an arbitrary value).
    whiteBlocks = whiteBlocks.filter(whiteBlock => whiteBlock.height >= 25);
    // Determine the bounds of the rectangles that remain when the blocks of white are removed.
    let rectangles = [];
    for (let index = 0; index <= whiteBlocks.length; index++) {
        let y = (index === 0) ? bounds.y : (whiteBlocks[index - 1].y + whiteBlocks[index - 1].height);
        let height = ((index === whiteBlocks.length) ? (bounds.y + bounds.height) : whiteBlocks[index].y) - y;
        if (height > 0)
            rectangles.push({ x: bounds.x, y: y, width: bounds.width, height: height });
    }
    return rectangles;
}
// Segments an image horizontally (within the specified bounds) by searching for blocks of
// consecutive, white (or close to white) vertical lines.
function segmentImageHorizontally(jimpImage, bounds) {
    let whiteBlocks = [];
    let isPreviousWhiteLine = false;
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
        // Count the number of white pixels across the current vertical line.
        let whiteCount = 0;
        for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
            let value = jimpImage.getPixelColor(x, y);
            if (value === 0xffffffff) // performance improvement (for the common case of a pure white pixel)
                whiteCount++;
            else {
                let color = jimp.intToRGBA(value);
                if (color.r > 240 && color.g > 240 && color.b > 240) // white or just off-white
                    whiteCount++;
            }
        }
        // If the line is mostly white pixels then it is considered a white line.
        let isWhiteLine = (whiteCount >= bounds.height - 2); // allow up to two non-white pixels
        if (isWhiteLine) {
            if (isPreviousWhiteLine)
                whiteBlocks[whiteBlocks.length - 1].width++; // increase the size of the current block
            else
                whiteBlocks.push({ x: x, width: 1 }); // start a new block
        }
        isPreviousWhiteLine = isWhiteLine;
    }
    // Only keep blocks of white that consist of 25 consecutive lines or more (an arbitrary value).
    whiteBlocks = whiteBlocks.filter(whiteBlock => whiteBlock.width >= 25);
    // Determine the bounds of the rectangles that remain when the blocks of white are removed.
    let rectangles = [];
    for (let index = 0; index <= whiteBlocks.length; index++) {
        let x = (index === 0) ? bounds.x : (whiteBlocks[index - 1].x + whiteBlocks[index - 1].width);
        let width = ((index === whiteBlocks.length) ? (bounds.x + bounds.width) : whiteBlocks[index].x) - x;
        if (width > 0)
            rectangles.push({ x: x, y: bounds.y, width: width, height: bounds.height });
    }
    return rectangles;
}
// Gets the record count number from the first page.
function getRecordCount(elements, startElement) {
    let topmostY = (startElement === undefined) ? Number.MAX_VALUE : startElement.y;
    // Find the "Records" text (allowing for spelling errors).
    let recordsElement = elements.find(element => element.y < topmostY &&
        didyoumean(element.text, ["Records"], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null);
    // Get the number to the right of "Records".
    if (recordsElement !== undefined) {
        let recordNumberElement = elements.find(element => element.x > recordsElement.x + recordsElement.width &&
            getVerticalOverlapPercentage(element, recordsElement) > 50);
        if (recordNumberElement !== undefined) {
            let recordCount = Number(recordNumberElement.text); // returns NaN if invalid
            if (!isNaN(recordCount))
                return recordCount;
        }
    }
    return -1;
}
// Finds the start element of each development application on the current PDF page (there are
// typically three development applications on a single page and each development application
// typically begins with the text "Dev App No.").
function findStartElements(elements) {
    // Examine all the elements on the page that being with "d".
    let startElements = [];
    for (let element of elements.filter(element => element.text.trim().toLowerCase().startsWith("d"))) {
        // Extract up to 10 elements to the right of the element that has text starting with the
        // letter "d" (and so may be the start of the "Dev App No" or "Dev App No." text).  Join
        // together the elements to the right in an attempt to find the best match to the text
        // "Dev App No" or "Dev App No.".
        let rightElement = element;
        let rightElements = [];
        let matches = [];
        do {
            rightElements.push(rightElement);
            // Allow for common misspellings of the "no." text.
            let text = rightElements.map(element => element.text).join("").replace(/[\s,\-_]/g, "").replace(/n0/g, "no").replace(/n°/g, "no").replace(/"o/g, "no").replace(/"0/g, "no").replace(/"°/g, "no").replace(/“°/g, "no").toLowerCase();
            if (text.length >= 11) // stop once the text is too long
                break;
            if (text.length >= 7) { // ignore until the text is close to long enough
                if (text === "devappno" || text === "devappno.")
                    matches.push({ element: rightElement, threshold: 0 });
                else if (didyoumean(text, ["DevAppNo", "DevAppNo."], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 1, trimSpace: true }) !== null)
                    matches.push({ element: rightElement, threshold: 1 });
                else if (didyoumean(text, ["DevAppNo", "DevAppNo."], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null)
                    matches.push({ element: rightElement, threshold: 2 });
            }
            rightElement = getRightElement(elements, rightElement);
        } while (rightElement !== undefined && rightElements.length < 10);
        // Chose the best match (if any matches were found).
        if (matches.length > 0) {
            let bestMatch = matches.reduce((previous, current) => (previous === undefined ||
                previous.threshold < current.threshold ||
                (previous.threshold === current.threshold && Math.abs(previous.text.length - "DevAppNo.".length) <= Math.abs(current.text.length - "DevAppNo.".length)) ? current : previous), undefined);
            startElements.push(bestMatch.element);
        }
    }
    // Ensure the start elements are sorted in the order that they appear on the page.
    let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
    startElements.sort(yComparer);
    return startElements;
}
// Converts image data from the PDF to a Jimp format image.
function convertToJimpImage(image) {
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
    return jimpImage;
}
// Parses an image (from a PDF document).
async function parseImage(image, bounds) {
    // Convert the image data into a format that can be used by jimp and then segment the image
    // based on blocks of white.
    let segments = segmentImage(convertToJimpImage(image));
    if (global.gc)
        global.gc();
    let elements = [];
    for (let segment of segments) {
        // Attempt to avoid using too much memory by scaling down large images.
        let scaleFactor = 1.0;
        if (segment.bounds.width * segment.bounds.height > 1000 * 1000) {
            scaleFactor = 0.5;
            console.log(`Scaling a large image (${segment.bounds.width}×${segment.bounds.height}) by ${scaleFactor} to reduce memory usage.`);
            segment.image = segment.image.scale(scaleFactor, jimp.RESIZE_BEZIER);
        }
        // Note that textord_old_baselines is set to 0 so that text that is offset by half the
        // height of the the font is correctly recognised.
        let imageBuffer = await new Promise((resolve, reject) => segment.image.getBuffer(jimp.MIME_PNG, (error, buffer) => error ? reject(error) : resolve(buffer)));
        segment.image = undefined; // attempt to release memory
        let memoryUsage = process.memoryUsage();
        if (memoryUsage.rss > 200 * 1024 * 1024) // 200 MB
            console.log(`Memory Usage: rss: ${Math.round(memoryUsage.rss / (1024 * 1024))} MB, heapTotal: ${Math.round(memoryUsage.heapTotal / (1024 * 1024))} MB, heapUsed: ${Math.round(memoryUsage.heapUsed / (1024 * 1024))} MB, external: ${Math.round(memoryUsage.external / (1024 * 1024))} MB`);
        if (segment.bounds.width * segment.bounds.height > 700 * 700)
            console.log(`Parsing a large image with bounds { x: ${Math.round(segment.bounds.x)}, y: ${Math.round(segment.bounds.y)}, width: ${Math.round(segment.bounds.width)}, height: ${Math.round(segment.bounds.height)} }.`);
        let result = await new Promise((resolve, reject) => { tesseract.recognize(imageBuffer, { textord_old_baselines: "0" }).then(function (result) { resolve(result); }); });
        tesseract.terminate();
        if (global.gc)
            global.gc();
        // Simplify the lines (remove most of the information generated by tesseract.js).
        if (result.blocks && result.blocks.length)
            for (let block of result.blocks)
                for (let paragraph of block.paragraphs)
                    for (let line of paragraph.lines)
                        elements = elements.concat(line.words.map(word => {
                            return {
                                text: word.text,
                                confidence: word.confidence,
                                choiceCount: word.choices.length,
                                x: bounds.x + segment.bounds.x + word.bbox.x0 / scaleFactor,
                                y: bounds.y + segment.bounds.y + word.bbox.y0 / scaleFactor,
                                width: (word.bbox.x1 - word.bbox.x0) / scaleFactor,
                                height: (word.bbox.y1 - word.bbox.y0) / scaleFactor
                            };
                        }));
    }
    return elements;
}
// Parses a PDF document.
async function parsePdf(url) {
    let developmentApplications = [];
    let recordCount = -1;
    // Read the PDF.
    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    // Parse the PDF.  Each page has the details of multiple applications.  Note that the PDF is
    // re-parsed on each iteration of the loop (ie. once for each page).  This then avoids large
    // memory usage by the PDF (just calling page._destroy() on each iteration of the loop is not
    // enough to release all memory used by the PDF parsing).
    for (let pageIndex = 0; pageIndex < 1000; pageIndex++) { // limit to an arbitrarily large number of pages (to avoid any chance of an infinite loop)
        let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
        if (pageIndex >= pdf.numPages)
            break;
        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);
        let viewportTest = await page.getViewport(1.0);
        let operators = await page.getOperatorList();
        // Ensure that the page is not rotated.
        if (page.rotate !== 0) {
            console.log(`Ignoring page ${pageIndex + 1} because it is rotated ${page.rotate}°.`);
            continue;
        }
        // Find and parse any images in the current PDF page.
        let elements = [];
        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] !== pdfjs.OPS.paintImageXObject && operators.fnArray[index] !== pdfjs.OPS.paintImageMaskXObject)
                continue;
            // The operator either contains the name of an image or an actual image.
            let image = operators.argsArray[index][0];
            if (typeof image === "string")
                image = page.objs.get(image); // get the actual image using its name
            // Obtain the transform that applies to the image.  Note that the first image in the
            // PDF typically has a pdfjs.OPS.dependency element in the fnArray between it and its
            // transform (pdfjs.OPS.transform).
            let transform = undefined;
            if (index - 1 >= 0 && operators.fnArray[index - 1] === pdfjs.OPS.transform)
                transform = operators.argsArray[index - 1];
            else if (index - 2 >= 0 && operators.fnArray[index - 1] === pdfjs.OPS.dependency && operators.fnArray[index - 2] === pdfjs.OPS.transform)
                transform = operators.argsArray[index - 2];
            else
                continue;
            let bounds = {
                x: (transform[4] * image.height) / transform[3],
                y: ((viewportTest.height - transform[5] - transform[3]) * image.height) / transform[3],
                width: image.width,
                height: image.height
            };
            // Parse the text from the image.
            elements = elements.concat(await parseImage(image, bounds));
            if (global.gc)
                global.gc();
        }
        // Release the memory used by the PDF now that it is no longer required (it will be
        // re-parsed on the next iteration of the loop for the next page).
        await pdf.destroy();
        if (global.gc)
            global.gc();
        // Ignore extremely low height elements (because these can be parsed as text but are
        // very unlikely to be actual text; for example see the October 2016 PDF on page 19).
        // In some rare cases they may be valid (such as a full stop far from other text).
        elements = elements.filter(element => element.height > 2);
        // Sort the elements by Y co-ordinate and then by X co-ordinate.
        let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        elements.sort(elementComparer);
        // Group the elements into sections based on where the "Dev App No." text starts (and
        // any other element the "Dev Ap No." elements line up with horizontally with a margin
        // of error equal to about the height of the "Dev App No." text; this is done in order
        // to capture the lodged date, which may be higher up than the "Dev App No." text).
        let applicationElementGroups = [];
        let startElements = findStartElements(elements);
        for (let index = 0; index < startElements.length; index++) {
            // Determine the highest Y co-ordinate of this row and the next row (or the bottom of
            // the current page).  Allow some leeway vertically (add some extra height) because
            // in some cases the lodged date is a fair bit higher up than the "Dev App No." text.
            let startElement = startElements[index];
            let raisedStartElement = {
                text: startElement.text,
                confidence: startElement.confidence,
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
        // The first page typically has a record count which can be used to determine if all
        // applications are successfully parsed later.
        if (pageIndex === 0 && startElements.length >= 1) // first page
            recordCount = getRecordCount(elements, startElements[0]);
        // Parse the development application from each group of elements (ie. a section of the
        // current page of the PDF document).  If the same application number is encountered a
        // second time in the same document then this likely indicates the parsing of the images
        // has incorrectly recognised some of the digits in the application number.  In this case
        // add a suffix to the application number so it is unique (and so will be inserted into
        // the database later instead of being ignored).
        for (let applicationElementGroup of applicationElementGroups) {
            let developmentApplication = parseApplicationElements(applicationElementGroup.elements, applicationElementGroup.startElement, url);
            if (developmentApplication !== undefined) {
                let suffix = 0;
                let applicationNumber = developmentApplication.applicationNumber;
                while (developmentApplications.some(otherDevelopmentApplication => otherDevelopmentApplication.applicationNumber === developmentApplication.applicationNumber))
                    developmentApplication.applicationNumber = `${applicationNumber} (${++suffix})`; // add a unique suffix
                developmentApplications.push(developmentApplication);
            }
        }
    }
    // Check whether the expected number of development applications have been encountered.
    if (recordCount !== -1) {
        let recordCountDiscrepancy = recordCount - developmentApplications.length;
        if (recordCountDiscrepancy <= -2)
            console.log(`Warning: ${-recordCountDiscrepancy} extra records were extracted from the PDF (record count at start of PDF: ${recordCount}; extracted application count: ${developmentApplications.length}).`);
        else if (recordCountDiscrepancy == -1)
            console.log(`Warning: 1 extra record was extracted from the PDF (record count at start of PDF: ${recordCount}; extracted application count: ${developmentApplications.length}).`);
        else if (recordCountDiscrepancy == 1)
            console.log(`Warning: 1 record was not extracted from the PDF (record count at start of PDF: ${recordCount}; extracted application count: ${developmentApplications.length}).`);
        else if (recordCountDiscrepancy >= 2)
            console.log(`Warning: ${recordCountDiscrepancy} records were not extracted from the PDF (record count at start of PDF: ${recordCount}; extracted application count: ${developmentApplications.length}).`);
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
    // Read all street, street suffix, suburb, state and post code information.
    readAddressInformation();
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
    console.log("Attempt to parse many PDFs (as a memory usage test).");
    let selectedPdfUrls = [
        "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20November%202015.pdf",
        "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20October%202016.pdf",
        "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20November%202016.pdf",
        "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20August%202017.pdf",
        "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202018.pdf",
        "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20May%202016.pdf",
        "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20November%202017.pdf",
        "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevAppSeptember%202015.pdf"
    ];
    // let selectedPdfUrls: string[] = [];
    // selectedPdfUrls.push(pdfUrls.shift());
    // if (pdfUrls.length > 0)
    //     selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    // if (getRandom(0, 2) === 0)
    //     selectedPdfUrls.reverse();
    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);
        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).
        if (global.gc)
            global.gc();
        console.log(`Inserting development applications into the database.`);
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}
main().then(() => console.log("Complete.")).catch(error => console.error(error));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsa0dBQWtHO0FBQ2xHLHNDQUFzQztBQUN0QyxFQUFFO0FBQ0YsZUFBZTtBQUNmLG1CQUFtQjtBQUVuQixZQUFZLENBQUM7O0FBRWIseUJBQXlCO0FBRXpCLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0hBQXNILENBQUMsQ0FBQztBQUNwSSxJQUFJLElBQUksR0FBRyxFQUFFLENBQUMsWUFBWSxDQUFDLHlDQUF5QyxDQUFDLENBQUMsUUFBUSxFQUFFLENBQUMsT0FBTyxDQUFDLHNFQUFzRSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0FBQ3pLLEVBQUUsQ0FBQyxhQUFhLENBQUMseUNBQXlDLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFFbEUsbUNBQW1DO0FBQ25DLGtEQUFrRDtBQUNsRCxtQ0FBbUM7QUFDbkMsaUNBQWlDO0FBQ2pDLGlDQUFpQztBQUNqQyxvQ0FBb0M7QUFDcEMsMENBQTBDO0FBQzFDLDZCQUE2QjtBQUM3QiwwQ0FBMEM7QUFFMUMsT0FBTyxDQUFDLE9BQU8sRUFBRSxDQUFDO0FBRWxCLE1BQU0sMEJBQTBCLEdBQUcsb0RBQW9ELENBQUM7QUFDeEYsTUFBTSxVQUFVLEdBQUcsdUNBQXVDLENBQUM7QUFLM0QscUNBQXFDO0FBRXJDLElBQUksV0FBVyxHQUFHLElBQUksQ0FBQztBQUN2QixJQUFJLGNBQWMsR0FBRyxJQUFJLENBQUM7QUFDMUIsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBRXZCLDhCQUE4QjtBQUU5QixLQUFLLFVBQVUsa0JBQWtCO0lBQzdCLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbkMsSUFBSSxRQUFRLEdBQUcsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ25ELFFBQVEsQ0FBQyxTQUFTLENBQUMsR0FBRyxFQUFFO1lBQ3BCLFFBQVEsQ0FBQyxHQUFHLENBQUMsOExBQThMLENBQUMsQ0FBQztZQUM3TSxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDdEIsQ0FBQyxDQUFDLENBQUM7SUFDUCxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUM7QUFFRCw4REFBOEQ7QUFFOUQsS0FBSyxVQUFVLFNBQVMsQ0FBQyxRQUFRLEVBQUUsc0JBQXNCO0lBQ3JELE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbkMsSUFBSSxZQUFZLEdBQUcsUUFBUSxDQUFDLE9BQU8sQ0FBQywyREFBMkQsQ0FBQyxDQUFDO1FBQ2pHLFlBQVksQ0FBQyxHQUFHLENBQUM7WUFDYixzQkFBc0IsQ0FBQyxpQkFBaUI7WUFDeEMsc0JBQXNCLENBQUMsT0FBTztZQUM5QixzQkFBc0IsQ0FBQyxXQUFXO1lBQ2xDLHNCQUFzQixDQUFDLGNBQWM7WUFDckMsc0JBQXNCLENBQUMsVUFBVTtZQUNqQyxzQkFBc0IsQ0FBQyxVQUFVO1lBQ2pDLHNCQUFzQixDQUFDLFlBQVk7U0FDdEMsRUFBRSxVQUFTLEtBQUssRUFBRSxHQUFHO1lBQ2xCLElBQUksS0FBSyxFQUFFO2dCQUNQLE9BQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQ3JCLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQzthQUNqQjtpQkFBTTtnQkFDSCxJQUFJLElBQUksQ0FBQyxPQUFPLEdBQUcsQ0FBQztvQkFDaEIsT0FBTyxDQUFDLEdBQUcsQ0FBQywrQkFBK0Isc0JBQXNCLENBQUMsaUJBQWlCLHFCQUFxQixzQkFBc0IsQ0FBQyxPQUFPLHFCQUFxQixzQkFBc0IsQ0FBQyxXQUFXLDBCQUEwQixzQkFBc0IsQ0FBQyxZQUFZLHVCQUF1QixDQUFDLENBQUM7O29CQUVuUixPQUFPLENBQUMsR0FBRyxDQUFDLDhCQUE4QixzQkFBc0IsQ0FBQyxpQkFBaUIscUJBQXFCLHNCQUFzQixDQUFDLE9BQU8scUJBQXFCLHNCQUFzQixDQUFDLFdBQVcsMEJBQTBCLHNCQUFzQixDQUFDLFlBQVksb0RBQW9ELENBQUMsQ0FBQztnQkFDblQsWUFBWSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUUscUJBQXFCO2dCQUMvQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUM7YUFDaEI7UUFDTCxDQUFDLENBQUMsQ0FBQztJQUNQLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQztBQWtCRCw4RkFBOEY7QUFDOUYsa0dBQWtHO0FBQ2xHLCtGQUErRjtBQUMvRiw0REFBNEQ7QUFFNUQsU0FBUyxTQUFTLENBQUMsUUFBbUIsRUFBRSxZQUFxQjtJQUN6RCxJQUFJLEdBQUcsR0FBRyxZQUFZLENBQUMsQ0FBQyxDQUFDO0lBQ3pCLEtBQUssSUFBSSxPQUFPLElBQUksUUFBUTtRQUN4QixJQUFJLE9BQU8sQ0FBQyxDQUFDLEdBQUcsWUFBWSxDQUFDLENBQUMsR0FBRyxZQUFZLENBQUMsTUFBTSxJQUFJLE9BQU8sQ0FBQyxDQUFDLEdBQUcsT0FBTyxDQUFDLE1BQU0sR0FBRyxZQUFZLENBQUMsQ0FBQyxFQUFHLG9CQUFvQjtZQUN0SCxJQUFJLDRCQUE0QixDQUFDLFlBQVksRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFLEVBQUcsaUNBQWlDO2dCQUM1RixJQUFJLE9BQU8sQ0FBQyxDQUFDLEdBQUcsR0FBRztvQkFDZixHQUFHLEdBQUcsT0FBTyxDQUFDLENBQUMsQ0FBQztJQUNoQyxPQUFPLEdBQUcsQ0FBQztBQUNmLENBQUM7QUFFRCxvRkFBb0Y7QUFFcEYsU0FBUyxTQUFTLENBQUMsVUFBcUIsRUFBRSxVQUFxQjtJQUMzRCxJQUFJLEVBQUUsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDLEVBQUUsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzlDLElBQUksRUFBRSxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLENBQUMsRUFBRSxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDOUMsSUFBSSxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxLQUFLLEVBQUUsVUFBVSxDQUFDLENBQUMsR0FBRyxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDcEYsSUFBSSxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxNQUFNLEVBQUUsVUFBVSxDQUFDLENBQUMsR0FBRyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdEYsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFO1FBQ3BCLE9BQU8sRUFBRSxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEVBQUUsR0FBRyxFQUFFLEVBQUUsTUFBTSxFQUFFLEVBQUUsR0FBRyxFQUFFLEVBQUUsQ0FBQzs7UUFFekQsT0FBTyxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsQ0FBQztBQUNuRCxDQUFDO0FBRUQsc0NBQXNDO0FBRXRDLFNBQVMsT0FBTyxDQUFDLFNBQW9CO0lBQ2pDLE9BQU8sU0FBUyxDQUFDLEtBQUssR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFDO0FBQzlDLENBQUM7QUFFRCx3RUFBd0U7QUFFeEUsU0FBUyxpQkFBaUIsQ0FBQyxRQUFpQixFQUFFLFFBQWlCO0lBQzNELElBQUksTUFBTSxHQUFHLEVBQUUsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLEtBQUssRUFBRSxDQUFDLEVBQUUsUUFBUSxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO0lBQ3JGLElBQUksTUFBTSxHQUFHLEVBQUUsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztJQUNwRSxJQUFJLE1BQU0sQ0FBQyxDQUFDLEdBQUcsTUFBTSxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsS0FBSyxHQUFHLENBQUMsRUFBRyxrQ0FBa0M7UUFDN0UsT0FBTyxNQUFNLENBQUMsU0FBUyxDQUFDO0lBQzVCLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsTUFBTSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN6RyxDQUFDO0FBRUQscUVBQXFFO0FBRXJFLFNBQVMsaUJBQWlCLENBQUMsUUFBaUIsRUFBRSxRQUFpQjtJQUMzRCxPQUFPLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxJQUFJLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDO0FBQ2xHLENBQUM7QUFFRCxpR0FBaUc7QUFDakcsNkZBQTZGO0FBQzdGLDJCQUEyQjtBQUUzQixTQUFTLDRCQUE0QixDQUFDLFFBQWlCLEVBQUUsUUFBaUI7SUFDdEUsSUFBSSxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMxQyxJQUFJLEVBQUUsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFDLEdBQUcsUUFBUSxDQUFDLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUM5RSxPQUFPLENBQUMsRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUMsR0FBRyxHQUFHLENBQUMsR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDakUsQ0FBQztBQUVELCtGQUErRjtBQUMvRix3Q0FBd0M7QUFFeEMsU0FBUyxlQUFlLENBQUMsUUFBbUIsRUFBRSxPQUFnQjtJQUMxRCxJQUFJLGNBQWMsR0FBWSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsVUFBVSxFQUFFLENBQUMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLFNBQVMsRUFBRSxDQUFDLEVBQUUsTUFBTSxDQUFDLFNBQVMsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUNoSSxLQUFLLElBQUksWUFBWSxJQUFJLFFBQVE7UUFDN0IsSUFBSSxpQkFBaUIsQ0FBQyxPQUFPLEVBQUUsWUFBWSxDQUFDLElBQUssc0RBQXNEO1lBQ25HLDRCQUE0QixDQUFDLE9BQU8sRUFBRSxZQUFZLENBQUMsR0FBRyxFQUFFLElBQUssOERBQThEO1lBQzNILENBQUMsWUFBWSxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSyw4Q0FBOEM7WUFDL0YsQ0FBQyxZQUFZLENBQUMsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDLElBQUssMEdBQTBHO1lBQ2xLLGlCQUFpQixDQUFDLE9BQU8sRUFBRSxZQUFZLENBQUMsR0FBRyxpQkFBaUIsQ0FBQyxPQUFPLEVBQUUsY0FBYyxDQUFDLEVBQUcsc0RBQXNEO1lBQzlJLGNBQWMsR0FBRyxZQUFZLENBQUM7SUFDdEMsT0FBTyxDQUFDLGNBQWMsQ0FBQyxJQUFJLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDO0FBQzVFLENBQUM7QUFFRCwyRkFBMkY7QUFDM0YsOEZBQThGO0FBQzlGLDBGQUEwRjtBQUMxRiwyRkFBMkY7QUFFM0YsU0FBUyxlQUFlLENBQUMsUUFBbUIsRUFBRSxZQUFxQixFQUFFLGFBQXNCO0lBQ3ZGLElBQUksV0FBVyxHQUFHLFFBQVEsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FDeEMsT0FBTyxDQUFDLENBQUMsR0FBRyxZQUFZLENBQUMsQ0FBQyxHQUFHLFlBQVksQ0FBQyxLQUFLO1FBQy9DLE9BQU8sQ0FBQyxDQUFDLEdBQUcsYUFBYSxDQUFDLENBQUMsR0FBRyxHQUFHLEdBQUcsYUFBYSxDQUFDLEtBQUs7UUFDdkQsNEJBQTRCLENBQUMsT0FBTyxFQUFFLFlBQVksQ0FBQyxHQUFHLEVBQUUsQ0FDM0QsQ0FBQztJQUVGLHdEQUF3RDtJQUV4RCxJQUFJLFNBQVMsR0FBRyxDQUFDLENBQVUsRUFBRSxDQUFVLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDckYsV0FBVyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUM1QixPQUFPLFdBQVcsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLENBQUM7QUFDNUYsQ0FBQztBQUVELHlEQUF5RDtBQUV6RCxTQUFTLHNCQUFzQjtJQUMzQixXQUFXLEdBQUcsRUFBRSxDQUFBO0lBQ2hCLEtBQUssSUFBSSxJQUFJLElBQUksRUFBRSxDQUFDLFlBQVksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLFFBQVEsRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFO1FBQ2xHLElBQUksZ0JBQWdCLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUN2QyxJQUFJLFVBQVUsR0FBRyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUM1QyxJQUFJLFVBQVUsR0FBRyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUM1QyxJQUFJLFdBQVcsQ0FBQyxVQUFVLENBQUMsS0FBSyxTQUFTO1lBQ3JDLFdBQVcsQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUM7UUFDakMsV0FBVyxDQUFDLFVBQVUsQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFFLHFEQUFxRDtLQUNuRztJQUVELGNBQWMsR0FBRyxFQUFFLENBQUM7SUFDcEIsS0FBSyxJQUFJLElBQUksSUFBSSxFQUFFLENBQUMsWUFBWSxDQUFDLG9CQUFvQixDQUFDLENBQUMsUUFBUSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUU7UUFDckcsSUFBSSxrQkFBa0IsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3pDLGNBQWMsQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxHQUFHLGtCQUFrQixDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0tBQzdGO0lBRUQsV0FBVyxHQUFHLEVBQUUsQ0FBQztJQUNqQixLQUFLLElBQUksSUFBSSxJQUFJLEVBQUUsQ0FBQyxZQUFZLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxRQUFRLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRTtRQUNsRyxJQUFJLFlBQVksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ25DLElBQUksVUFBVSxHQUFHLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQztRQUN0RCxJQUFJLHNCQUFzQixHQUFHLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNwRCxXQUFXLENBQUMsVUFBVSxDQUFDLEdBQUcsc0JBQXNCLENBQUM7S0FDcEQ7QUFDTCxDQUFDO0FBRUQsaUdBQWlHO0FBQ2pHLGdHQUFnRztBQUNoRyxnR0FBZ0c7QUFDaEcsMERBQTBEO0FBRTFELFNBQVMsZ0JBQWdCLENBQUMsUUFBbUIsRUFBRSxXQUFvQixFQUFFLFlBQXFCLEVBQUUsYUFBc0I7SUFDOUcsNkZBQTZGO0lBQzdGLDhGQUE4RjtJQUM5RixvQkFBb0I7SUFFcEIsSUFBSSxlQUFlLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUM1QyxPQUFPLENBQUMsQ0FBQyxHQUFHLFlBQVksQ0FBQyxDQUFDLEdBQUcsWUFBWSxDQUFDLE1BQU07UUFDaEQsT0FBTyxDQUFDLENBQUMsR0FBRyxhQUFhLENBQUMsQ0FBQyxHQUFHLEdBQUcsR0FBRyxhQUFhLENBQUMsS0FBSztRQUN2RCxPQUFPLENBQUMsQ0FBQyxHQUFHLFdBQVcsQ0FBQyxDQUFDLEdBQUcsV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUUsbUVBQW1FO0lBRXpILDBGQUEwRjtJQUMxRiw0RkFBNEY7SUFDNUYseUZBQXlGO0lBQ3pGLDJGQUEyRjtJQUMzRiwwQkFBMEI7SUFFMUIsSUFBSSxvQkFBb0IsR0FBRyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUMsUUFBUSxFQUFFLE9BQU8sRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsYUFBYSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsS0FBSyxTQUFTLElBQUksT0FBTyxDQUFDLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUUsU0FBUyxDQUFDLENBQUM7SUFDcE0sSUFBSSxvQkFBb0IsS0FBSyxTQUFTO1FBQ2xDLE9BQU8sRUFBRSxDQUFDO0lBRWQsd0VBQXdFO0lBRXhFLGVBQWUsR0FBRyxRQUFRLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQ3hDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsWUFBWSxDQUFDLENBQUMsR0FBRyxZQUFZLENBQUMsTUFBTTtRQUNoRCxPQUFPLENBQUMsQ0FBQyxHQUFHLGFBQWEsQ0FBQyxDQUFDLEdBQUcsR0FBRyxHQUFHLGFBQWEsQ0FBQyxLQUFLO1FBQ3ZELE9BQU8sQ0FBQyxDQUFDLEdBQUcsV0FBVyxDQUFDLENBQUMsR0FBRyxXQUFXLENBQUMsTUFBTSxJQUFNLG1FQUFtRTtRQUN2SCxPQUFPLENBQUMsQ0FBQyxJQUFJLG9CQUFvQixDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsb0JBQW9CLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztJQUVqRyxxRkFBcUY7SUFDckYsNEZBQTRGO0lBRTVGLElBQUksZUFBZSxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNoTCxlQUFlLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDO0lBRXRDLDZGQUE2RjtJQUM3Riw0RkFBNEY7SUFDNUYsa0VBQWtFO0lBRWxFLGVBQWUsR0FBRyxlQUFlLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQy9DLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsRUFBRSxDQUNqQyxPQUFPLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSyxzRUFBc0U7UUFDdkgsT0FBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7UUFDcEIsT0FBTyxDQUFDLFNBQVMsQ0FBQyxPQUFPLEVBQUUsWUFBWSxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsR0FBRyxDQUNyRSxDQUNKLENBQUM7SUFFRiwyRkFBMkY7SUFDM0Ysd0ZBQXdGO0lBQ3hGLDhGQUE4RjtJQUU5RixLQUFLLElBQUksS0FBSyxHQUFHLENBQUMsRUFBRSxLQUFLLEdBQUcsZUFBZSxDQUFDLE1BQU0sRUFBRSxLQUFLLEVBQUUsRUFBRTtRQUN6RCxJQUFJLGVBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxlQUFlLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxlQUFlLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsRUFBRSxFQUFHLDZCQUE2QjtZQUNuSSxJQUFJLGVBQWUsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsVUFBVSxJQUFJLEVBQUUsSUFBSSxlQUFlLENBQUMsS0FBSyxDQUFDLENBQUMsVUFBVSxJQUFJLEVBQUUsRUFBRSxFQUFHLHdFQUF3RTtnQkFDbkssZUFBZSxDQUFDLE1BQU0sR0FBRyxLQUFLLENBQUMsQ0FBRSw4RUFBOEU7Z0JBQy9HLE1BQU07YUFDVDtTQUNKO0tBQ0o7SUFFRCxPQUFPLGVBQWUsQ0FBQztBQUMzQixDQUFDO0FBRUQsMkRBQTJEO0FBRTNELFNBQVMsMEJBQTBCLENBQUMsUUFBbUIsRUFBRSxZQUFxQjtJQUMxRSxtRkFBbUY7SUFFbkYsSUFBSSx1QkFBdUIsR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQ2xELE9BQU8sQ0FBQyxDQUFDLEdBQUcsWUFBWSxDQUFDLENBQUM7UUFDMUIsVUFBVSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsQ0FBRSxtQkFBbUIsRUFBRSxXQUFXLENBQUUsRUFBRSxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsVUFBVSxFQUFFLHFCQUFxQixFQUFFLGFBQWEsRUFBRSxlQUFlLEVBQUUsU0FBUyxFQUFFLENBQUMsRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsS0FBSyxJQUFJLENBQUMsQ0FBQztJQUV6TSxJQUFJLHVCQUF1QixLQUFLLFNBQVM7UUFDckMsT0FBTyx1QkFBdUIsQ0FBQztJQUVuQyw0REFBNEQ7SUFFNUQsSUFBSSxrQkFBa0IsR0FBRyxRQUFRLENBQUMsTUFBTSxDQUNwQyxPQUFPLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsWUFBWSxDQUFDLENBQUM7UUFDckMsVUFBVSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsQ0FBRSxZQUFZLEVBQUUsT0FBTyxDQUFFLEVBQUUsRUFBRSxhQUFhLEVBQUUsS0FBSyxFQUFFLFVBQVUsRUFBRSxxQkFBcUIsRUFBRSxhQUFhLEVBQUUsZUFBZSxFQUFFLFNBQVMsRUFBRSxDQUFDLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLEtBQUssSUFBSSxDQUFDLENBQUM7SUFFOUwscUZBQXFGO0lBRXJGLEtBQUssSUFBSSxpQkFBaUIsSUFBSSxrQkFBa0IsRUFBRTtRQUM5QyxJQUFJLHNCQUFzQixHQUFHLGVBQWUsQ0FBQyxRQUFRLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUMxRSxJQUFJLHNCQUFzQixLQUFLLFNBQVMsSUFBSSxVQUFVLENBQUMsc0JBQXNCLENBQUMsSUFBSSxFQUFFLENBQUUsUUFBUSxFQUFFLEtBQUssQ0FBRSxFQUFFLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxVQUFVLEVBQUUscUJBQXFCLEVBQUUsYUFBYSxFQUFFLGVBQWUsRUFBRSxTQUFTLEVBQUUsQ0FBQyxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxLQUFLLElBQUk7WUFDek8sT0FBTyxpQkFBaUIsQ0FBQztLQUNoQztJQUVELE9BQU8sU0FBUyxDQUFDO0FBQ3JCLENBQUM7QUFFRCxtREFBbUQ7QUFFbkQsU0FBUyxzQkFBc0IsQ0FBQyxRQUFtQixFQUFFLFlBQXFCLEVBQUUsYUFBc0I7SUFDOUYsd0ZBQXdGO0lBQ3hGLDZGQUE2RjtJQUM3Riw2RUFBNkU7SUFFN0UsSUFBSSxZQUFZLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksYUFBYSxDQUFDLENBQUM7UUFDdEUsT0FBTyxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsTUFBTSxHQUFHLFlBQVksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLFlBQVksQ0FBQyxNQUFNO1FBQ3JFLE9BQU8sQ0FBQyxDQUFDLEdBQUcsWUFBWSxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsWUFBWSxDQUFDLE1BQU07UUFDcEQsTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEVBQUUsV0FBVyxFQUFFLElBQUksQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7SUFFOUQsNEZBQTRGO0lBRTVGLElBQUksbUJBQW1CLEdBQUcsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDLFFBQVEsRUFBRSxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLEtBQUssU0FBUyxJQUFJLFFBQVEsQ0FBQyxDQUFDLEdBQUcsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQzNKLE9BQU8sbUJBQW1CLENBQUM7QUFDL0IsQ0FBQztBQUVELHdCQUF3QjtBQUV4QixTQUFTLGNBQWMsQ0FBQyxRQUFtQixFQUFFLFlBQXFCLEVBQUUsYUFBc0IsRUFBRSxtQkFBNEI7SUFDcEgsb0VBQW9FO0lBRXBFLElBQUkscUJBQXFCLEdBQUcsQ0FBQyxtQkFBbUIsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxtQkFBbUIsQ0FBQztJQUVyRyw0RUFBNEU7SUFFNUUsSUFBSSw0QkFBNEIsR0FBRyxhQUFhLENBQUM7SUFFakQsZ0NBQWdDO0lBRWhDLElBQUksbUJBQW1CLEdBQUcsUUFBUSxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcscUJBQXFCLENBQUMsQ0FBQyxHQUFHLHFCQUFxQixDQUFDLE1BQU07UUFDbkgsT0FBTyxDQUFDLENBQUMsR0FBRyw0QkFBNEIsQ0FBQyxDQUFDO1FBQzFDLE9BQU8sQ0FBQyxDQUFDLEdBQUcsNEJBQTRCLENBQUMsQ0FBQyxHQUFHLEdBQUcsR0FBRyw0QkFBNEIsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUUzRix5RkFBeUY7SUFDekYsMkZBQTJGO0lBQzNGLGtFQUFrRTtJQUVsRSxJQUFJLGVBQWUsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDcE0sbUJBQW1CLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxDQUFDO0lBRTFDLDJEQUEyRDtJQUUzRCxPQUFPLG1CQUFtQixDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7QUFDNUksQ0FBQztBQUVELHFDQUFxQztBQUVyQyxTQUFT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
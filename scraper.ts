// Parses the development applications at the South Australian The Rural City of Murray Bridge web
// site and places them in a database.
//
// Michael Bone
// 18th August 2018

"use strict";

import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as urlparser from "url";
import * as moment from "moment";
import * as pdfjs from "pdfjs-dist";
import * as tesseract from "tesseract.js";
import * as jimp from "jimp";
import * as didyoumean from "didyoumean2";
import * as fs from "fs";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "http://www.murraybridge.sa.gov.au/page.aspx?u=1022";
const CommentUrl = "mailto:council@murraybridge.sa.gov.au";

declare const global: any;
declare const process: any;

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
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// A bounding rectangle.

interface Rectangle {
    x: number,
    y: number,
    width: number,
    height: number
}

// An element (consisting of text and a bounding rectangle) in a PDF document.

interface Element extends Rectangle {
    text: string
}

// Returns the text of the element with all whitespace removed, changed to lowercase and some
// punctuation removed (for example, the full stop from "Dev App No.").

function condenseText(element: Element) {
    if (element === undefined || element.text === undefined)
        return undefined;
    return element.text.trim().replace(/[\s.,\-_]/g, "").toLowerCase();
}

// Gets the highest Y co-ordinate of all elements that are considered to be in the same row as
// the specified element.

function getRowTop(elements: Element[], startElement: Element) {
    let top = startElement.y;
    for (let element of elements)
        if (element.y < startElement.y + startElement.height && element.y + element.height > startElement.y)
            if (element.y < top)
                top = element.y;
    return top;
}

// Constructs a rectangle based on the intersection of the two specified rectangles.

function constructIntersection(rectangle1: Rectangle, rectangle2: Rectangle): Rectangle {
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

function constructUnion(rectangle1: Rectangle, rectangle2: Rectangle): Rectangle {
    let x1 = Math.min(rectangle1.x, rectangle2.x);
    let x2 = Math.max(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y1 = Math.min(rectangle1.y, rectangle2.y);
    let y2 = Math.max(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// Calculates the area of a rectangle.

function getArea(rectangle: Rectangle) {
    return rectangle.width * rectangle.height;
}

// Calculates the square of the Euclidean distance between two elements.

function calculateDistance(element1: Element, element2: Element) {
    let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
    let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
    if (point2.x < point1.x - element1.width / 5)  // arbitrary overlap factor of 20%
        return Number.MAX_VALUE;
    return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
}

// Determines whether there is vertical overlap between two elements.

function isVerticalOverlap(element1: Element, element2: Element) {
    return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
}

// Gets the percentage of vertical overlap between two elements (0 means no overlap and 100 means
// 100% overlap; and, for example, 20 means that 20% of the second element overlaps somewhere
// with the first element).

function getVerticalOverlapPercentage(element1: Element, element2: Element) {
    let y1 = Math.max(element1.y, element2.y);
    let y2 = Math.min(element1.y + element1.height, element2.y + element2.height);
    return (y2 < y1) ? 0 : (((y2 - y1) * 100) / element2.height);
}

// Gets the element immediately to the right of the specified element.

function getRightElement(elements: Element[], element: Element) {
    let closestElement: Element = { text: undefined, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let rightElement of elements)
        if (isVerticalOverlap(element, rightElement) && calculateDistance(element, rightElement) < calculateDistance(element, closestElement))
            closestElement = rightElement;
    return (closestElement.text === undefined) ? undefined : closestElement;
}

// Gets the text to the right of the specified startElement up to the left hand side of the
// specified middleElement (adjusted left by 20% of the width of the middleElement as a safety
// precaution).  Only elements that overlap 50% or more in the vertical direction with the
// specified startElement are considered (ie. elements on the same "row").

function getRightRowText(elements: Element[], startElement: Element, middleElement: Element) {
    let rowElements = elements.filter(element =>
        element.x > startElement.x + startElement.width &&
        element.x < middleElement.x - 0.2 * middleElement.width &&
        getVerticalOverlapPercentage(element, startElement) > 50
    );

    // Sort and then join the elements into a single string.

    let xComparer = (a: Element, b: Element) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
    rowElements.sort(xComparer);
    return rowElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
}

// Gets the text to the right in a rectangle, where the rectangle is delineated by the positions in
// which the three specified strings of (case sensitive) text are found.

function getRightText(elements: Element[], topLeftText: string, rightText: string, bottomText: string) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.

    let topLeftElement = elements.find(element => element.text.trim() == topLeftText);
    let rightElement = (rightText === undefined) ? undefined : elements.find(element => element.text.trim() == rightText);
    let bottomElement = (bottomText === undefined) ? undefined: elements.find(element => element.text.trim() == bottomText);
    if (topLeftElement === undefined)
        return undefined;

    let x = topLeftElement.x + topLeftElement.width;
    let y = topLeftElement.y;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);

    let bounds: Rectangle = { x: x, y: y, width: width, height: height };

    // Gather together all elements that are at least 50% within the bounding rectangle.

    let intersectingElements: Element[] = []
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

// Reads all the address information into global objects.

function readAddressInformation() {
    StreetNames = {}
    for (let line of fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetNameTokens = line.split(",");
        let streetName = streetNameTokens[0].trim();
        let suburbName = streetNameTokens[1].trim();
        if (StreetNames[streetName] === undefined)
            StreetNames[streetName] = [];
        StreetNames[streetName].push(suburbName);  // several suburbs may exist for the same street name
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

// Formats (and corrects) an address.

function formatAddress(address: string) {
    if (address.trim() === "")
        return "";

    let tokens = address.split(" ");

    // It is common for an invalid postcode of "0" to appear on the end of an address.  Remove
    // this if it is present.  For example, "Bremer Range RD CALLINGTON 0".   

    let postCode = tokens[tokens.length - 1];
    if (/^[0-9]{4}$/.test(postCode))
        tokens.pop();
    else if (postCode === "O" || postCode === "0" || postCode === "D") {
        postCode = "";
        tokens.pop();
    } else
        postCode = "";

    // Pop tokens from the end of the array until a valid suburb name is encountered (allowing
    // for a few spelling errors).

    let suburbName = null;
    for (let index = 1; index <= 4; index++) {
        let suburbNameMatch = didyoumean(tokens.slice(-index).join(" "), Object.keys(SuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
        if (suburbNameMatch !== null) {
            suburbName = SuburbNames[suburbNameMatch];
            tokens.splice(-index, index);  // remove elements from the end of the array           
            break;
        }
    }

    if (suburbName === null)  // suburb name not found (or not recognised)
        return tokens.join(" ");

    // Expand an abbreviated street suffix.  For example, expand "RD" to "Road".

    let streetSuffixAbbreviation = tokens.pop() || "";
    let streetSuffix = StreetSuffixes[streetSuffixAbbreviation.toLowerCase()] || streetSuffixAbbreviation;

    // Allow minor spelling corrections in the remaining tokens to construct a street name.

    let streetName = (tokens.join(" ") + " " + streetSuffix).trim();
    let streetSuburbNames = undefined;
    let streetNameMatch = didyoumean(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
    if (streetNameMatch !== null) {
        streetName = streetNameMatch;
        streetSuburbNames = StreetNames[streetNameMatch];
    }

    console.log(`Address: ${address}`);
    console.log(`  Street Name: ${streetName}`)
    console.log(`  Street Suffix: ${streetSuffix}`)
    console.log(`  Suburb Name: ${suburbName}`);
    console.log(`  Street Suburb Names: ${streetSuburbNames}`);
    console.log(`  Post Code: ${postCode}`);

    return (streetName + ((streetName === "") ? "" : ", ") + suburbName).trim();
}

// Gets the text downwards in a rectangle, where the rectangle is delineated by the positions in
// which the three specified strings of (case sensitive) text are found.

function getDownText(elements: Element[], topText: string, rightText: string, bottomText: string) {
    // Construct a bounding rectangle in which the expected text should appear.  Any elements
    // over 50% within the bounding rectangle will be assumed to be part of the expected text.

    let topElement = elements.find(element => element.text.trim() == topText);
    let rightElement = (rightText === undefined) ? undefined : elements.find(element => element.text.trim() == rightText);
    let bottomElement = (bottomText === undefined) ? undefined: elements.find(element => element.text.trim() == bottomText);
    if (topElement === undefined)
        return undefined;

    let x = topElement.x;
    let y = topElement.y + topElement.height;
    let width = (rightElement === undefined) ? Number.MAX_VALUE : (rightElement.x - x);
    let height = (bottomElement === undefined) ? Number.MAX_VALUE : (bottomElement.y - y);

    let bounds: Rectangle = { x: x, y: y, width: width, height: height };

    // Gather together all elements that are at least 50% within the bounding rectangle.

    let intersectingElements: Element[] = []
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

function parseApplicationElements(elements: Element[], startElement: Element, informationUrl: string) {
    console.log("----------Elements for one Application----------");
    // for (let element of elements)
    //     console.log(`    [${element.text}] (${element.x},${element.y}) ${element.width}×${element.height} confidence=${Math.round((element as any).confidence)}%`);
    //     // console.log(`    [${element.text}] (${Math.round(element.x)},${Math.round(element.y)}) ${element.width}×${element.height} confidence=${Math.round((element as any).confidence)}%`);

console.log("Refactor assessment number logic to a separate function.");

    // Find the "Assessment Number" text (allowing for spelling errors).

    let assessmentNumberElement = elements.find(element =>
        element.y > startElement.y &&
        didyoumean(element.text, [ "Assessment Number" ], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null);
    
    if (assessmentNumberElement === undefined) {
        // Find any occurrences of the text "Assessment".

        let assessmentElements = elements.filter(
            element => element.y > startElement.y &&
            didyoumean(element.text, [ "Assessment" ], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null);

        // Check if any of those occurrences of "Assessment" are followed by "Number".

        for (let assessmentElement of assessmentElements) {
            let assessmentRightElement = getRightElement(elements, assessmentElement);
            if (assessmentRightElement !== null && didyoumean(assessmentRightElement.text, [ "Number" ], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null) {
                assessmentNumberElement = assessmentElement;
                break;
            }
        }
    }

    if (assessmentNumberElement === undefined) {
        console.log("Could not find the \"Assessment Number\" text on the PDF page for the current development application.  The development application will be ignored.");
        return undefined;
    }

    // Find the "Applicant" text.

    let applicantElement = elements.find(element => element.y > startElement.y && element.text.trim().toLowerCase() === "applicant");
if (applicantElement === undefined)
    console.log("    Could not find applicantElement.");

    // Find the "Builder" text.

    let builderElement = elements.find(element => element.y > startElement.y && element.text.trim().toLowerCase() === "builder");
if (builderElement === undefined)
    console.log("    Could not find builderElement.");

    // One of either the applicant or builder elements is required in order to determine where
    // the description text starts on the X axis (and where the development application number
    // and address end on the X axis).

    let middleElement = (applicantElement === undefined) ? builderElement : applicantElement;
    if (middleElement === undefined) {
        console.log("Could not find the \"Applicant\" or \"Builder\" text on the PDF page for the current development application.  The development application will be ignored.");
        return undefined;
    }

    let applicationNumber = getRightRowText(elements, startElement, middleElement).trim().replace(/\s/g, "");
    applicationNumber = applicationNumber.replace(/[IlL\[\]\|’,]/g, "/");  // for example, converts "17I2017" to "17/2017"

    if (applicationNumber === "") {
        console.log("Could not find the application number on the PDF page for the current development application.  The development application will be ignored.");
        return undefined;
    }

    console.log(`Application Number: ${applicationNumber}`);

console.log("Refactor received date logic to a separate function.");

    // Search to the right of "Dev App No." for the lodged date (including up and down a few
    // "lines" from the "Dev App No." text because sometimes the lodged date is offset vertically
    // by a fair amount; in some cases offset up and in other cases offset down).

    let dateElements = elements.filter(element =>
        element.x >= middleElement.x &&
        element.y + element.height > startElement.y - startElement.height &&
        element.y < startElement.y + 2 * startElement.height &&
        moment(element.text.trim(), "D/MM/YYYY", true).isValid());

    // Select the left most date (ie. favour the "lodged" date over the "final descision" date).

    let receivedDate: moment.Moment = undefined;
    let receivedDateElement = dateElements.reduce((previous, current) => ((previous === undefined || previous.x > current.x) ? current : previous), undefined);
    if (receivedDateElement !== undefined)
        receivedDate = moment(receivedDateElement.text.trim(), "D/MM/YYYY", true);
    
    if (receivedDate !== undefined)
        console.log(`Received Date: ${receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : ""}`)

console.log("Refactor description logic to a separate function.");

    // Set the element which delineates the top of the description text.

    let descriptionTopElement = (receivedDateElement === undefined) ? startElement : receivedDateElement;

    // Set the element which delineates the bottom left of the description text.

    let descriptionBottomLeftElement = middleElement;

    // Extract the description text.

    let descriptionElements = elements.filter(element =>
        element.y > descriptionTopElement.y + descriptionTopElement.height &&
        element.y < descriptionBottomLeftElement.y &&
        element.x > descriptionBottomLeftElement.x - 0.2 * descriptionBottomLeftElement.width);

    // Sort the description elements by Y co-ordinate and then by X co-ordinate (the Math.max
    // expressions exist to allow for the Y co-ordinates of elements to be not exactly aligned;
    // for example, hyphens in text such as "Retail Fitout - Shop 7").

    let elementComparer = (a, b) => (a.y > b.y + (Math.max(a.height, b.height) * 2) / 3) ? 1 : ((a.y < b.y - (Math.max(a.height, b.height) * 2) / 3) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    descriptionElements.sort(elementComparer);

    // Construct the description from the description elements.

    let description = descriptionElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl");
    console.log(`Description: ${description}`);

console.log("Refactor address logic to a separate function.");

    // Find the elements above (at least a "line" above) the "Assessment Number" text and to the
    // left of the middleElement.  These elements correspond to the address (assumed to be on one
    // single line).

    let addressElements = elements.filter(element =>
        element.y < assessmentNumberElement.y - assessmentNumberElement.height &&
        element.x < middleElement.x - 0.2 * middleElement.width);

    // Find the lowest address element (this is assumed to form part of the single line of the
    // address).

    let addressBottomElement = addressElements.reduce((previous, current) => ((previous === undefined || current.y > previous.y) ? current : previous), undefined);
    if (addressBottomElement === undefined) {
        console.log(`Application number ${applicationNumber} will be ignored because an address was not found (searching upwards from the "Assessment Number" text).`);
        return undefined;
    }
console.log(`addressBottomElement is (${addressBottomElement.x},${addressBottomElement.y}) width=${addressBottomElement.width} height=${addressBottomElement.height}`);

    // Obtain all elements on the same "line" as the lowest address element.

console.log(`assessmentNumberElement is (${assessmentNumberElement.x},${assessmentNumberElement.y}) width=${assessmentNumberElement.width} height=${assessmentNumberElement.height}`);
console.log(`middleElement is (x=${middleElement.x},y=${middleElement.y}) width=${middleElement.width} height=${middleElement.height}`);

    addressElements = elements.filter(element =>
        element.y < assessmentNumberElement.y - assessmentNumberElement.height &&
        element.x < middleElement.x - 0.2 * middleElement.width &&
        element.y >= addressBottomElement.y - Math.max(element.height, addressBottomElement.height));

    // Sort the address elements by Y co-ordinate and then by X co-ordinate (the Math.max
    // expressions exist to allow for the Y co-ordinates of elements to be not exactly aligned).

    elementComparer = (a, b) => (a.y > b.y + Math.max(a.height, b.height)) ? 1 : ((a.y < b.y - Math.max(a.height, b.height)) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
    addressElements.sort(elementComparer);

    // Remove any smaller elements (say less than half the area) that are 90% or more encompassed
    // by another element (this then avoids some artefacts of the text recognition, ie. elements
    // such as "r~" and "-" that can otherwise overlap the main text).

console.log("-----Address elements before:");
for (let element of addressElements)
    console.log(`    [${element.text}] (${element.x},${element.y}) ${element.width}×${element.height} confidence=${Math.round((element as any).confidence)}%`);

    addressElements = addressElements.filter(element =>
        !addressElements.some(otherElement =>
            getArea(otherElement) > 2 * getArea(element) &&  // smaller element (ie. the other element is at least double the area)
            getArea(element) > 0 &&
            getArea(constructIntersection(element, otherElement)) / getArea(element) > 0.9
        )
    );

    // Remove any address elements that occur after a sizeable gap.  Any such elements are very
    // likely part of the description (not the address) because sometimes the description is
    // moved to the left, closer to the address (see "Crystal Report - DevAppSeptember 2015.pdf").

    for (let index = 1; index < addressElements.length; index++) {
        if (addressElements[index].x - (addressElements[index - 1].x + addressElements[index - 1].width) > 50) {  // gap greater than 50 pixels
            addressElements.length = index;  // remove the element and all following elements that appear after a large gap
            break;
        }
    }

console.log("-----Address elements after:");
for (let element of addressElements)
    console.log(`    [${element.text}] (${element.x},${element.y}) ${element.width}×${element.height} confidence=${Math.round((element as any).confidence)}%`);

    // Construct the address from the discovered address elements (and attempt to correct some
    // spelling errors).

    let address = addressElements.map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl").replace(/\\\//g, "V");
    address = formatAddress(address);
    console.log(`Address: ${address}`);

    // for (let element of elements)
    //     console.log(`[${Math.round(element.x)},${Math.round(element.y)}] ${element.text}`);
    console.log("----------");

    return {
        applicationNumber: applicationNumber,
        address: address,
        description: ((description === "") ? "No description provided" : description),
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: (receivedDate !== undefined && receivedDate.isValid()) ? receivedDate.format("YYYY-MM-DD") : ""
    }
}

// Segments an image vertically and horizontally based on blocks of white (or almost white) pixels
// in order to avoid using too much memory.  Very often a large image will be mostly white space.
// A very simple horizontal and then vertical search is performed for consecutive lines of white
// (or mostly white) pixels.

let imageCount = 0;
let imageSegmentedCount = 0;

function segmentImage(jimpImage: any) {
    let segments: { image: jimp, bounds: Rectangle }[] = [];
    let bounds = { x: 0, y: 0, width: jimpImage.bitmap.width, height: jimpImage.bitmap.height };

// imageCount++;
// console.log(`Writing image ${imageCount}`);
// jimpImage.write(`C:\\Temp\\Murray Bridge\\Reconstructed\\Reconstructed.Images.${imageCount}.png`);

    // Only segment large images (do not waste time on small images which are already small enough
    // that they will not cause too much memory to be used).

    if (jimpImage.bitmap.width * jimpImage.bitmap.height > 500 * 500) {
        let rectangles: Rectangle[] = [];
        let verticalRectangles = segmentImageVertically(jimpImage, bounds);
        for (let verticalRectangle of verticalRectangles)
            rectangles = rectangles.concat(segmentImageHorizontally(jimpImage, verticalRectangle));
    
        for (let rectangle of rectangles) {
            let croppedJimpImage: jimp = new (jimp as any)(rectangle.width, rectangle.height);
            croppedJimpImage.blit(jimpImage, 0, 0, rectangle.x, rectangle.y, rectangle.width, rectangle.height);

// imageSegmentedCount++;
// console.log(`    Writing segmented image ${imageSegmentedCount} to file.`);
// croppedJimpImage.write(`C:\\Temp\\Murray Bridge\\Problem\\Large Image.${imageConvertCount}.Segment${imageSegmentedCount}.${rectangle.width}×${rectangle.height}.png`);
            
            segments.push({ image: croppedJimpImage, bounds: rectangle });
        }
    }
    
    if (segments.length === 0)
        segments.push({ image: jimpImage, bounds: bounds});

    return segments;
}

// Segments an image vertically (within the specified bounds) by searching for blocks of
// consecutive, white (or close to white) horizontal lines.

function segmentImageVertically(jimpImage: any, bounds: Rectangle) {
    let whiteBlocks = [];

    let isPreviousWhiteLine = false;
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
        // Count the number of white pixels across the current horizontal line.

        let whiteCount = 0;
        for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
            let value = jimpImage.getPixelColor(x, y);
            if (value === 0xffffffff)  // performance improvement (for the common case of a pure white pixel)
                whiteCount++;
            else {
                let color = (jimp as any).intToRGBA(value);
                if (color.r > 240 && color.g > 240 && color.b > 240)  // white or just off-white
                    whiteCount++;
            }
        }

        // If the line is mostly white pixels then it is considered a white line.

        let isWhiteLine = (whiteCount >= bounds.width - 2);  // allow up to two non-white pixels

        if (isWhiteLine) {
            if (isPreviousWhiteLine)
                whiteBlocks[whiteBlocks.length - 1].height++;  // increase the size of the current block
            else
                whiteBlocks.push({ y: y, height: 1 });  // start a new block
        }

        isPreviousWhiteLine = isWhiteLine;
    }

    // Only keep blocks of white that consist of 25 consecutive lines or more (an arbitrary value).

    whiteBlocks = whiteBlocks.filter(whiteBlock => whiteBlock.height >= 25);

    // Determine the bounds of the rectangles that remain when the blocks of white are removed.

    let rectangles = [];
    for (let index = 0; index <= whiteBlocks.length; index++) {
        let y = (index === 0) ? 0 : (whiteBlocks[index - 1].y + whiteBlocks[index - 1].height);
        let height = ((index === whiteBlocks.length) ? (bounds.y + bounds.height) : whiteBlocks[index].y) - y;
        if (height > 0)
            rectangles.push({ x: bounds.x, y: y, width: bounds.width, height: height });
    }

    return rectangles;
}

// Segments an image horizontally (within the specified bounds) by searching for blocks of
// consecutive, white (or close to white) vertical lines.

function segmentImageHorizontally(jimpImage: any, bounds: Rectangle) {
    let whiteBlocks = [];

    let isPreviousWhiteLine = false;
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
        // Count the number of white pixels across the current vertical line.

        let whiteCount = 0;
        for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
            let value = jimpImage.getPixelColor(x, y);
            if (value === 0xffffffff)  // performance improvement (for the common case of a pure white pixel)
                whiteCount++;
            else {
                let color = (jimp as any).intToRGBA(value);
                if (color.r > 240 && color.g > 240 && color.b > 240)  // white or just off-white
                    whiteCount++;
            }
        }

        // If the line is mostly white pixels then it is considered a white line.

        let isWhiteLine = (whiteCount >= bounds.height - 2);  // allow up to two non-white pixels

        if (isWhiteLine) {
            if (isPreviousWhiteLine)
                whiteBlocks[whiteBlocks.length - 1].width++;  // increase the size of the current block
            else
                whiteBlocks.push({ x: x, width: 1 });  // start a new block
        }

        isPreviousWhiteLine = isWhiteLine;
    }

    // Only keep blocks of white that consist of 25 consecutive lines or more (an arbitrary value).

    whiteBlocks = whiteBlocks.filter(whiteBlock => whiteBlock.width >= 25);

    // Determine the bounds of the rectangles that remain when the blocks of white are removed.

    let rectangles = [];
    for (let index = 0; index <= whiteBlocks.length; index++) {
        let x = (index === 0) ? 0 : (whiteBlocks[index - 1].x + whiteBlocks[index - 1].width);
        let width = ((index === whiteBlocks.length) ? (bounds.x + bounds.width) : whiteBlocks[index].x) - x;
        if (width > 0)
            rectangles.push({ x: x, y: bounds.y, width: width, height: bounds.height });
    }

    return rectangles;
}

// Converts image data from the PDF to a Jimp format image.

let imageConvertCount = 0;

function convertToJimpImage(image: any) {
    let pixelSize = (8 * image.data.length) / (image.width * image.height);
    let jimpImage = null;

    if (pixelSize === 1) {
        // A monochrome image (one bit per pixel).

        jimpImage = new (jimp as any)(image.width, image.height);
        for (let x = 0; x < image.width; x++) {
            for (let y = 0; y < image.height; y++) {
                let index = y * (image.width / 8);
                let bitIndex = x % 8;
                let byteIndex = (x - bitIndex) / 8;
                index += byteIndex;
                let color = null;
                if ((image.data[index] & (128 >> bitIndex)) === 0)
                    color = jimp.rgbaToInt(0, 0, 0, 255);  // black pixel
                else
                    color = jimp.rgbaToInt(255, 255, 255, 255);  // white pixel
                jimpImage.setPixelColor(color, x, y);
            }
        }
    } else {
        // Assume a 24 bit colour image (3 bytes per pixel).

        jimpImage = new (jimp as any)(image.width, image.height);
        for (let x = 0; x < image.width; x++) {
            for (let y = 0; y < image.height; y++) {
                let index = (y * image.width * 3) + (x * 3);
                let color = jimp.rgbaToInt(image.data[index], image.data[index + 1], image.data[index + 2], 255);
                jimpImage.setPixelColor(color, x, y);
            }
        }
    }

// imageConvertCount++;
// console.log(`Writing image ${imageConvertCount} to file.`);
// jimpImage.write(`C:\\Temp\\Murray Bridge\\Problem\\Large Image.${imageConvertCount}.${image.width}×${image.height}.png`);

    return jimpImage;
}

// Parses an image (from a PDF document).

async function parseImage(image: any, bounds: Rectangle) {
    // Convert the image data into a format that can be used by jimp and then segment the image
    // based on blocks of white.

    let segments = segmentImage(convertToJimpImage(image));
    if (global.gc)
        global.gc();

    let elements: Element[] = [];
    for (let segment of segments) {
        // Note that textord_old_baselines is set to 0 so that text that is offset by half the height
        // of the the font is correctly recognised.

        let imageBuffer = await new Promise((resolve, reject) => segment.image.getBuffer(jimp.MIME_PNG, (error, buffer) => error ? reject(error) : resolve(buffer)));
        let result: any = await new Promise((resolve, reject) => { tesseract.recognize(imageBuffer, { textord_old_baselines: "0" }).then(function(result) { resolve(result); }) });

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
                                x: word.bbox.x0 + bounds.x + segment.bounds.x,
                                y: word.bbox.y0 + bounds.y + segment.bounds.y,
                                width: (word.bbox.x1 - word.bbox.x0),
                                height: (word.bbox.y1 - word.bbox.y0)
                            };
                        }));
    }

    return elements;
}

// Parses a PDF document.

async function parsePdf(url: string) {
    let developmentApplications = [];

    // Read the PDF.

let hasAlreadyParsed = true;
let fileName = decodeURI(new urlparser.URL(url).pathname.split("/").pop());
console.log(`Reading "${fileName}" from local disk.`);
let buffer = fs.readFileSync(`C:\\Temp\\Murray Bridge\\Problem\\${fileName}`);

    // let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    // await sleep(2000 + getRandom(0, 5) * 1000);

    // Parse the PDF.  Each page has the details of multiple applications.

    let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });

console.log("Get \"Records\" from first page and ensure that total is correct.");

    for (let index = 0; index < pdf.numPages; index++) {
        console.log(`Page ${index + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(index + 1);
        let viewportTest = await page.getViewport(1.0);
        let operators = await page.getOperatorList();

        // Find and parse any images in the current PDF page.

        let elements: Element[] = [];

if (hasAlreadyParsed) {
    console.log("Reading pre-parsed elements.");
    console.log(`Reading pre-parsed elements for page ${index + 1} of ${fileName}.`);
    elements = JSON.parse(fs.readFileSync(`C:\\Temp\\Murray Bridge\\Test Set\\${fileName}.Page${index + 1}.txt`, "utf8"));
} else {
    console.log("Parsing using slow approach.");
        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] !== pdfjs.OPS.paintImageXObject && operators.fnArray[index] !== pdfjs.OPS.paintImageMaskXObject)
                continue;

            // The operator either contains the name of an image or an actual image.

            let image = operators.argsArray[index][0];
            if (typeof image === "string")
                image = page.objs.get(image);  // get the actual image using its name
            else
                operators.argsArray[index][0] = undefined;  // attempt to release memory used by images

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

            let bounds: Rectangle = {
                x: (transform[4] * image.height) / transform[3],
                y: ((viewportTest.height - transform[5] - transform[3]) * image.height) / transform[3],
                width: image.width,
                height: image.height
            };

// console.log(`    Image: ${image.width}×${image.height}`);

            // Parse the text from the image.

            elements = elements.concat(await parseImage(image, bounds));
            if (global.gc)
                global.gc();
        }

// Reconstruct the image.
//
// let maximumWidth = Math.ceil(elements.reduce((maximum, element) => Math.max(maximum, element.x + element.width), 0));
// let maximumHeight = Math.ceil(elements.reduce((maximum, element) => Math.max(maximum, element.y + element.height), 0));
// console.log(`maximumWidth: ${maximumWidth}, maximumHeight: ${maximumHeight}, elements.length: ${elements.length}`);
//
// let reconstructedImage: any = await new Promise((resolve, reject) => new (jimp as any)(maximumWidth, maximumHeight, (error, image) => error ? reject(error) : resolve(image)));
// let font = await (jimp as any).loadFont(jimp.FONT_SANS_16_BLACK);
//
// for (let element of elements) {
//     let wordImage = new (jimp as any)(Math.round(element.width), Math.round(element.height), 0x776677ff);
//     reconstructedImage.blit(wordImage, element.x, element.y, 0, 0, element.width, element.height);
//     reconstructedImage.print(font, element.x, element.y, element.text);
// }
//
// console.log(`Writing reconstructed image for page ${index + 1} of ${fileName}.`);
// reconstructedImage.write(`C:\\Temp\\Murray Bridge\\Reconstructed\\Reconstructed.${fileName}.Page${index + 1}.png`);

    console.log(`Saving the elements for page ${index + 1} of ${fileName}.`);
    fs.writeFileSync(`C:\\Temp\\Murray Bridge\\Problem\\${fileName}.Page${index + 1}.txt`, JSON.stringify(elements));
    continue;
}

        // Sort the elements by Y co-ordinate and then by X co-ordinate.

        let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        elements.sort(elementComparer);

        // Group the elements into sections based on where the "Dev App No." text starts (and
        // any other element the "Dev Ap No." elements line up with horizontally with a margin
        // of error equal to about the height of the "Dev App No." text; in order to capture the
        // lodged date, which may be higher up than the "Dev App No." text).

        let startElements: Element[] = [];
        for (let startElement of elements.filter(element => element.text.trim().toLowerCase().startsWith("dev"))) {
            // Check that the elements next to "Dev" produce the text "Dev App No.".  Take care
            // as the text may possibly be spread across one, two or three elements (allow for
            // all these possibilities).

            // let startText = condenseText(startElement);
            // if (startText === "dev") {
            //     startElement = getRightElement(elements, startElement);
            //     startText = condenseText(startElement);
            //     if (startText !== "app")
            //         continue;  // not "Dev App"
            // } else if (startText !== "devapp") {
            //     continue;  // not "Dev App"
            // }

            let startText = condenseText(startElement);
            if (startText === "dev") {
                startElement = getRightElement(elements, startElement);
                startText = condenseText(startElement);
                if (startText === "app") {
                    startElement = getRightElement(elements, startElement);
                    startText = condenseText(startElement);
                    if (startText !== "no" && startText !== "n0" && startText !== "n°" && startText !== "\"o" && startText !== "\"0" && startText !== "\"°")
                        continue;  // not "Dev App No."
                } else if (startText !== "appno") {
                    continue;  // not "Dev App No."
                }
            } else if (startText === "devapp") {
                startElement = getRightElement(elements, startElement);
                startText = condenseText(startElement);
                if (startText !== "no")
                    continue; // not "Dev App No."
            } else if (startText !== "devappno") {
                continue;  // not "Dev App No."
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
            let raisedStartElement: Element = {
                text: startElement.text,
                x: startElement.x,
                y: startElement.y - 2 * startElement.height,  // leeway
                width: startElement.width,
                height: startElement.height };
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

function getRandom(minimum: number, maximum: number) {
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

console.log("Temporarily skipping read of page (for test set purposes).");
if (false) {

    // Retrieve the page that contains the links to the PDFs.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);

    let body = await request({ url: DevelopmentApplicationsUrl, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);
    
    let pdfUrls: string[] = [];
    for (let element of $("td.uContentListDesc a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl);
        pdfUrl.protocol = "http";  // force to use HTTP instead of HTTPS
        if (!pdfUrls.some(url => url === pdfUrl.href))  // avoid duplicates
            pdfUrls.push(pdfUrl.href);
    }

    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }

    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).

    // let selectedPdfUrls: string[] = [];
    // selectedPdfUrls.push(pdfUrls.shift());
    // if (pdfUrls.length > 0)
    //     selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    // if (getRandom(0, 2) === 0)
    //     selectedPdfUrls.reverse();

// selectedPdfUrls = [ "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202018.pdf", "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20February%202017.pdf" ];
// selectedPdfUrls = [ "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202018.pdf" ];
// selectedPdfUrls = [ "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20February%202017.pdf" ];
}

let selectedPdfUrls = [
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202018.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20June%202018.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20May%202018.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Development%20Decisions%20April%202018-1.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20February%202018.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20January%202018.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/December%202017.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20November%202017.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20October%202017.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20September%202017.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20August%202017.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202017.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20June%202017.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20May%202017.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20April%202017-1.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20April%202017.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20February%202017.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20January%202017.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20December%202016.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20November%202016.pdf",  // crashed on this PDF 01-Sep-2018
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20October%202016.pdf",  // crashed on this PDF 10-Sep-2018
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20September%202016.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20August%202016.pdf",  // crashed on this PDF 11-Sep-2018
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202016.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20June%202016.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20May%202016.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20April%202016.pdf",  // try this one
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20March%202016.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20February%202016.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20January%202016.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20November%202015.pdf",  // images not parsed 20-Sep-2018
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20October%202015.pdf",
    "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevAppSeptember%202015.pdf",  // images not parsed 20-Sep-2018
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20August%202015.pdf",  // images not parsed 20-Sep-2018
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202015.pdf",  // images not parsed 20-Sep-2018
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystam%20Report%20-%20DevApproval%20June%202015.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20May%202015.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20April%202015.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20March%202015.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20February%202015.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20January%202015.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20November%202014.pdf"  // images not parsed 20-Sep-2018
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20October%202014.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20September%202014.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20August%202014.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20July%202014.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20June%202014.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20May%202014.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20April%202014.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20March%202014.pdf", 
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20February%202014.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApp%20January%202014.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Report%20-%20DevApproval%20November%202013.pdf",
    // "http://www.murraybridge.sa.gov.au/webdata/resources/files/Crystal%20Reports%20-%20DevApproval%20October%202013.pdf"
];

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

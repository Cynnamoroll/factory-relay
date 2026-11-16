import XCTest

final class RelayMacUITests: XCTestCase {
    func testIncrementChangesVisibleCount() {
        let app = XCUIApplication()
        app.launch()
        defer { app.terminate() }
        let count = app.staticTexts["relay-count"]
        XCTAssertTrue(count.waitForExistence(timeout: 10), "The launched Mac app exposes the count")
        XCTAssertEqual(count.value as? String, "Count: 0", "A fresh launch starts at zero")
        app.buttons["relay-increment"].click()
        XCTAssertEqual(count.value as? String, "Count: 1", "Clicking Increment changes visible state")
        app.buttons["relay-increment"].click()
        XCTAssertEqual(count.value as? String, "Count: 2", "A second click increments again")
    }
}

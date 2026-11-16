import XCTest

final class RelayDemoUITests: XCTestCase {
    func testIncrementChangesVisibleCount() {
        let app = XCUIApplication()
        app.launch()
        let count = app.staticTexts["relay-count"]
        XCTAssertTrue(count.waitForExistence(timeout: 10), "The launched app exposes the count")
        XCTAssertEqual(count.label, "Count: 0", "A fresh launch starts at zero")
        app.buttons["relay-increment"].tap()
        XCTAssertEqual(count.label, "Count: 1", "Tapping Increment changes visible state")
        app.buttons["relay-increment"].tap()
        XCTAssertEqual(count.label, "Count: 2", "A second tap increments again")
    }
}

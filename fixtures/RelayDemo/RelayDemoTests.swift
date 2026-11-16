import XCTest
@testable import RelayDemo

final class RelayDemoTests: XCTestCase {
    func testGreeting() {
        XCTAssertEqual(RelayModel.greeting, "Factory relay verified")
    }

    func testTotal() {
        XCTAssertEqual(RelayModel.total([2, 3, 5]), 10)
        XCTAssertEqual(RelayModel.total([]), 0)
    }
}

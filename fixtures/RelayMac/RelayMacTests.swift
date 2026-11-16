import XCTest
@testable import RelayMac

final class RelayMacTests: XCTestCase {
    func testGreeting() {
        XCTAssertEqual(RelayModel.greeting, "Factory relay verified")
    }

    func testTotal() {
        XCTAssertEqual(RelayModel.total([2, 3, 5]), 10)
        XCTAssertEqual(RelayModel.total([]), 0)
    }
}

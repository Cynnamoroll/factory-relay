enum RelayModel {
    static let greeting = "Factory relay verified"

    static func total(_ values: [Int]) -> Int {
        values.reduce(0, +)
    }
}

namespace LudoBrawl.Api.Models;

public class Room
{
    public required string Code { get; init; }
    public int HostId { get; set; }
    public List<Player> Players { get; } = new();
    public RoomState State { get; set; }
    public DateTimeOffset LastActivity { get; set; }
}
